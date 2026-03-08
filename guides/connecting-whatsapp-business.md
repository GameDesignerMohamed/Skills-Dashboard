# Connecting to WhatsApp Business

## Step 01 — Create Your Meta App

1. Go to [developers.facebook.com](https://developers.facebook.com) and log in with your Facebook account.
2. Click **Create App** → select **Other** → choose **Business** as app type.
3. Name your app (e.g. "MyMind WhatsApp"), enter your email, and connect your Meta Business Manager.
4. Once created, go to your app dashboard, click **Add Product**, find **WhatsApp**, and click **Set Up**.

## Step 02 — Add & Verify Your Phone Number

1. In your app, go to **WhatsApp → API Setup → Phone Numbers**.
2. Click **Add Phone Number** and enter your business display name.
3. Verify the number via SMS or voice call OTP.
4. Copy your **Phone Number ID** — you'll need this later.

## Step 03 — Generate a Permanent Access Token

1. Go to **Business Settings → Users → System Users**.
2. Click **Add**, name it (e.g. "MindAPI"), and set role to **Admin**.
3. Add your WhatsApp app as an asset with **full access**.
4. Click **Generate Token** with permissions: `whatsapp_business_management` and `whatsapp_business_messaging`.
5. Copy the **Permanent Access Token** — keep it private.

## Step 04 — Link to Your Mind

1. Paste the following message to your Mind:

   > Store this WhatsApp Business access token in your TENET: `{your_permanent_token}`. My Phone Number ID is `{your_phone_number_id}`.

3. Your Mind will store the credentials in TENET.apiKey.whatsapp_business.

## Step 05 — Send Your First Message

1. Tell your Mind: *"Send a WhatsApp message to +[phone number] saying hello."*
2. Your Mind will ask for Steward confirmation before sending.
3. Confirm, and the message goes out via the Cloud API.

> **Note:** Messages outside the 24-hour customer window require approved templates. Create templates in **Meta Business Manager → WhatsApp → Message Templates**, then tell your Mind to use them.
