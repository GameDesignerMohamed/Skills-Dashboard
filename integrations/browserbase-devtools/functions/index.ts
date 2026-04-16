import { defineFn } from "@browserbasehq/sdk-functions";
import lighthouse, { desktopConfig } from "lighthouse";
import { chromium } from "playwright-core";
import puppeteer from "puppeteer-core";
import { z } from "zod";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type CapturedConsoleMessage = {
  level: string;
  text: string;
  source: string | null;
  line: number | null;
};

type CapturedPageError = {
  message: string;
  stack: string | null;
};

type NetworkRequestSummary = {
  url: string;
  method: string;
  status: number | null;
  size: number | null;
  duration: number | null;
  type: string;
  errorText?: string | null;
};

const sharedSessionConfig = {
  region: "us-west-2",
  browserSettings: {
    logSession: true,
    recordSession: true,
  },
} as const;

const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
    message: "URL must use http:// or https://",
  });

const viewportSchema = z.object({
  width: z.number().int().positive().max(4000),
  height: z.number().int().positive().max(4000),
});

const screenshotParamsSchema = z.object({
  url: httpUrlSchema,
  fullPage: z.boolean().optional().default(false),
  viewport: viewportSchema.optional(),
});

const lighthouseCategorySchema = z.enum([
  "performance",
  "accessibility",
  "best-practices",
  "seo",
]);

const lighthouseParamsSchema = z.object({
  url: httpUrlSchema,
  categories: z.array(lighthouseCategorySchema).optional().default([
    "performance",
    "accessibility",
    "best-practices",
    "seo",
  ]),
});

const evaluateScriptParamsSchema = z.object({
  url: httpUrlSchema,
  script: z.string().min(1),
});

const waitMsSchema = z.number().int().min(0).max(30000).optional().default(3000);

const inspectNetworkParamsSchema = z.object({
  url: httpUrlSchema,
  waitMs: waitMsSchema,
});

const consoleLogsParamsSchema = z.object({
  url: httpUrlSchema,
  waitMs: waitMsSchema,
});

const pageHealthParamsSchema = z.object({
  url: httpUrlSchema,
});

const formFieldSchema = z.object({
  selector: z.string().min(1),
  value: z.string(),
});

const fillFormParamsSchema = z.object({
  url: httpUrlSchema,
  fields: z.array(formFieldSchema).min(1),
  submitSelector: z.string().min(1),
});

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }

  const serialized = JSON.stringify(value, (_key, nestedValue) => {
    if (typeof nestedValue === "bigint") {
      return nestedValue.toString();
    }

    return nestedValue;
  });

  if (serialized === undefined) {
    return null;
  }

  return JSON.parse(serialized) as JsonValue;
}

async function withPlaywrightPage<T>(
  connectUrl: string,
  viewport: z.infer<typeof viewportSchema> | undefined,
  callback: (page: import("playwright-core").Page) => Promise<T>,
): Promise<T> {
  const browser = await chromium.connectOverCDP(connectUrl);

  try {
    const browserContext = browser.contexts()[0] ?? (await browser.newContext());
    const page = browserContext.pages()[0] ?? (await browserContext.newPage());

    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);

    if (viewport) {
      await page.setViewportSize(viewport);
    }

    return await callback(page);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function withPuppeteerPage<T>(
  connectUrl: string,
  callback: (page: import("puppeteer-core").Page) => Promise<T>,
): Promise<T> {
  const browser = await puppeteer.connect({
    browserWSEndpoint: connectUrl,
    protocolTimeout: 30000,
  });

  try {
    const pages = await browser.pages();
    const page = pages[0] ?? (await browser.newPage());
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);

    return await callback(page);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function navigateAndSettle(
  page: import("playwright-core").Page,
  url: string,
  waitMs = 0,
) {
  const response = await page.goto(url, {
    timeout: 30000,
    waitUntil: "domcontentloaded",
  });

  await page.waitForLoadState("load", { timeout: 15000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);

  if (waitMs > 0) {
    await page.waitForTimeout(waitMs);
  }

  return response;
}

async function takeBase64Screenshot(
  page: import("playwright-core").Page,
  fullPage: boolean,
) {
  const buffer = await page.screenshot({
    fullPage,
    type: "png",
  });

  return buffer.toString("base64");
}

function attachConsoleCapture(page: import("playwright-core").Page) {
  const messages: CapturedConsoleMessage[] = [];
  const errors: CapturedPageError[] = [];

  page.on("console", (message) => {
    const location = message.location();

    messages.push({
      level: message.type(),
      text: message.text(),
      source: location.url || null,
      line: location.lineNumber ?? null,
    });

    if (message.type() === "error") {
      const locationText =
        location.url && location.lineNumber !== undefined
          ? `${location.url}:${location.lineNumber}`
          : location.url || null;

      errors.push({
        message: message.text(),
        stack: locationText,
      });
    }
  });

  page.on("pageerror", (error) => {
    errors.push({
      message: error.message,
      stack: error.stack ?? null,
    });
  });

  return { messages, errors };
}

function attachNetworkCapture(page: import("playwright-core").Page) {
  const startedAt = new Map<import("playwright-core").Request, number>();
  const requests: NetworkRequestSummary[] = [];

  page.on("request", (request) => {
    startedAt.set(request, Date.now());
  });

  page.on("response", async (response) => {
    const request = response.request();
    const startTime = startedAt.get(request);
    const headers = response.headers();
    const contentLengthHeader = headers["content-length"];
    const parsedSize = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : Number.NaN;

    requests.push({
      url: request.url(),
      method: request.method(),
      status: response.status(),
      size: Number.isFinite(parsedSize) ? parsedSize : null,
      duration: startTime ? Date.now() - startTime : null,
      type: request.resourceType(),
    });
  });

  page.on("requestfailed", (request) => {
    const startTime = startedAt.get(request);
    const failure = request.failure();

    requests.push({
      url: request.url(),
      method: request.method(),
      status: null,
      size: null,
      duration: startTime ? Date.now() - startTime : null,
      type: request.resourceType(),
      errorText: failure?.errorText ?? null,
    });
  });

  return requests;
}

function summarizeRequests(requests: NetworkRequestSummary[]) {
  const slowest =
    [...requests].sort((left, right) => (right.duration ?? -1) - (left.duration ?? -1))[0] ?? null;
  const largest =
    [...requests].sort((left, right) => (right.size ?? -1) - (left.size ?? -1))[0] ?? null;

  return {
    total: requests.length,
    failed: requests.filter((request) => request.status === null || request.status >= 400).length,
    slowest,
    largest,
  };
}

async function getPageMetrics(page: import("playwright-core").Page) {
  return page.evaluate(() => {
    const navigation = performance.getEntriesByType(
      "navigation",
    )[0] as PerformanceNavigationTiming | undefined;
    const paints = performance.getEntriesByType("paint");
    const firstPaint = paints.find((entry) => entry.name === "first-paint")?.startTime ?? null;
    const firstContentfulPaint =
      paints.find((entry) => entry.name === "first-contentful-paint")?.startTime ?? null;

    return {
      loadTime: navigation?.loadEventEnd ?? null,
      domContentLoaded: navigation?.domContentLoadedEventEnd ?? null,
      firstPaint,
      firstContentfulPaint,
    };
  });
}

function getCategoryScore(
  category: import("lighthouse").Result["categories"][string] | undefined,
) {
  if (!category || category.score === null) {
    return null;
  }

  return Math.round(category.score * 100);
}

async function fillField(
  page: import("playwright-core").Page,
  field: z.infer<typeof formFieldSchema>,
) {
  const locator = page.locator(field.selector).first();
  await locator.waitFor({ state: "visible", timeout: 10000 });

  const elementInfo = await locator.evaluate((element) => {
    const inputElement = element instanceof HTMLInputElement ? element : null;
    return {
      tagName: element.tagName.toLowerCase(),
      type: inputElement?.type?.toLowerCase() ?? "",
    };
  });

  if (elementInfo.tagName === "select") {
    await locator.selectOption({ label: field.value }).catch(async () => {
      await locator.selectOption(field.value);
    });
    return;
  }

  if (elementInfo.type === "checkbox") {
    if (["1", "true", "yes", "on"].includes(field.value.toLowerCase())) {
      await locator.check();
    } else {
      await locator.uncheck();
    }
    return;
  }

  if (elementInfo.type === "radio") {
    if (["1", "true", "yes", "on"].includes(field.value.toLowerCase())) {
      await locator.check();
    }
    return;
  }

  await locator.fill(field.value);
}

defineFn(
  "navigate-and-screenshot",
  async (context, params) => {
    return withPlaywrightPage(context.session.connectUrl, params.viewport, async (page) => {
      await navigateAndSettle(page, params.url);

      return {
        screenshot: await takeBase64Screenshot(page, params.fullPage),
        title: await page.title(),
        url: page.url(),
      };
    });
  },
  {
    parametersSchema: screenshotParamsSchema,
    sessionConfig: sharedSessionConfig,
  },
);

defineFn(
  "run-lighthouse",
  async (context, params) => {
    return withPuppeteerPage(context.session.connectUrl, async (page) => {
      const runnerResult = await lighthouse(
        params.url,
        {
          disableStorageReset: true,
          logLevel: "error",
          onlyCategories: params.categories,
        },
        desktopConfig,
        page,
      );

      if (!runnerResult) {
        throw new Error("Lighthouse did not return a result");
      }

      const lhr = runnerResult.lhr;
      const auditIds = [
        ...new Set(
          params.categories.flatMap(
            (category) => lhr.categories[category]?.auditRefs.map((auditRef) => auditRef.id) ?? [],
          ),
        ),
      ];

      const audits = auditIds
        .map((auditId) => {
          const audit = lhr.audits[auditId];

          if (!audit) {
            return null;
          }

          return {
            id: auditId,
            title: audit.title,
            score: audit.score === null ? null : Math.round(audit.score * 100),
            scoreDisplayMode: audit.scoreDisplayMode,
            displayValue: audit.displayValue ?? null,
            description: audit.description,
          };
        })
        .filter((audit): audit is NonNullable<typeof audit> => audit !== null)
        .sort((left, right) => (left.score ?? 101) - (right.score ?? 101));

      return {
        scores: {
          performance: getCategoryScore(lhr.categories.performance),
          accessibility: getCategoryScore(lhr.categories.accessibility),
          bestPractices: getCategoryScore(lhr.categories["best-practices"]),
          seo: getCategoryScore(lhr.categories.seo),
        },
        audits,
        fetchTime: lhr.fetchTime,
        url: lhr.finalUrl ?? params.url,
      };
    });
  },
  {
    parametersSchema: lighthouseParamsSchema,
    sessionConfig: sharedSessionConfig,
  },
);

defineFn(
  "evaluate-script",
  async (context, params) => {
    return withPlaywrightPage(context.session.connectUrl, undefined, async (page) => {
      const consoleCapture = attachConsoleCapture(page);
      await navigateAndSettle(page, params.url);

      const result = await page.evaluate(async (scriptSource) => {
        const runner = new Function(`
          return (async () => {
            ${scriptSource}
          })();
        `);

        return runner.call(window);
      }, params.script);

      return {
        result: toJsonValue(result),
        console: consoleCapture.messages.map((message) => message.text),
        errors: consoleCapture.errors.map((error) => ({
          message: error.message,
          stack: error.stack,
        })),
      };
    });
  },
  {
    parametersSchema: evaluateScriptParamsSchema,
    sessionConfig: sharedSessionConfig,
  },
);

defineFn(
  "inspect-network",
  async (context, params) => {
    return withPlaywrightPage(context.session.connectUrl, undefined, async (page) => {
      const requests = attachNetworkCapture(page);
      await navigateAndSettle(page, params.url, params.waitMs);

      return {
        requests,
        summary: summarizeRequests(requests),
      };
    });
  },
  {
    parametersSchema: inspectNetworkParamsSchema,
    sessionConfig: sharedSessionConfig,
  },
);

defineFn(
  "get-console-logs",
  async (context, params) => {
    return withPlaywrightPage(context.session.connectUrl, undefined, async (page) => {
      const consoleCapture = attachConsoleCapture(page);
      await navigateAndSettle(page, params.url, params.waitMs);

      return {
        messages: consoleCapture.messages,
        errors: consoleCapture.errors,
      };
    });
  },
  {
    parametersSchema: consoleLogsParamsSchema,
    sessionConfig: sharedSessionConfig,
  },
);

defineFn(
  "check-page-health",
  async (context, params) => {
    return withPlaywrightPage(context.session.connectUrl, undefined, async (page) => {
      const consoleCapture = attachConsoleCapture(page);
      const requests = attachNetworkCapture(page);
      await navigateAndSettle(page, params.url, 1000);

      const failedRequests = requests.filter(
        (request) => request.status === null || request.status >= 400,
      );

      return {
        screenshot: await takeBase64Screenshot(page, true),
        errors: consoleCapture.errors,
        failedRequests,
        metrics: await getPageMetrics(page),
      };
    });
  },
  {
    parametersSchema: pageHealthParamsSchema,
    sessionConfig: sharedSessionConfig,
  },
);

defineFn(
  "fill-and-submit-form",
  async (context, params) => {
    return withPlaywrightPage(context.session.connectUrl, undefined, async (page) => {
      await navigateAndSettle(page, params.url);

      for (const field of params.fields) {
        await fillField(page, field);
      }

      const beforeScreenshot = await page.screenshot({
        fullPage: true,
        type: "png",
      });

      const navigationPromise = page
        .waitForNavigation({
          timeout: 15000,
          waitUntil: "domcontentloaded",
        })
        .catch(() => null);

      await page.locator(params.submitSelector).first().click();

      const navigationResponse = await navigationPromise;
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);

      return {
        beforeScreenshot: beforeScreenshot.toString("base64"),
        afterScreenshot: (await page.screenshot({
          fullPage: true,
          type: "png",
        })).toString("base64"),
        response: {
          url: page.url(),
          status: navigationResponse?.status() ?? null,
        },
      };
    });
  },
  {
    parametersSchema: fillFormParamsSchema,
    sessionConfig: sharedSessionConfig,
  },
);
