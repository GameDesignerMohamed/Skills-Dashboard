# Asana Project Management Integration for AnimocaMinds/Ethoswarm

## Overview
This directory contains the complete Asana API integration for the AnimocaMinds/Ethoswarm platform. The integration enables Minds to manage Asana projects and tasks as an external execution layer, bridging cognitive intent to actionable project work.

## Files

### 1. Registry Offering (1_registry_offering.json)
- **offeringId**: ASANA-001-PM
- **Title**: Asana Project Suite v1.0
- **Base URL**: https://app.asana.com/api/1.0
- **Last Updated**: 2026-03-05
- **Description**: REST API v1.0 integration for project, task, and team workflow management

### 2. App Manifest (2_app_manifest.json)
- **App Name**: Asana_Suite
- **Domain**: project_management
- **Authentication**: Bearer Token (Personal Access Token)
- **Header Key**: Authorization
- **Tier**: verified
- **Tools Defined**: 6 (v1.0.0)

### 3. Tool Schemas (3_tool_schemas.json)
Complete parameter specifications for 6 tools:

1. **Asana_ListTasks**
   - Retrieve all tasks in a project
   - Required: project_gid
   - Optional: opt_fields, completed_on, is_blocking, is_blocked
   - Endpoint: GET /projects/{project_gid}/tasks

2. **Asana_GetTask**
   - Retrieve task details
   - Required: task_gid
   - Optional: opt_fields
   - Endpoint: GET /tasks/{task_gid}

3. **Asana_CreateTask**
   - Create new task
   - Required: name
   - Optional: projects, assignee, due_on, notes, workspace, external_id
   - Endpoint: POST /tasks
   - Constraint: Requires Steward confirmation

4. **Asana_UpdateTask**
   - Update task fields
   - Required: task_gid
   - Optional: name, due_on, assignee, notes, completed
   - Endpoint: PUT /tasks/{task_gid}
   - Constraint: Requires Steward confirmation for create/update

5. **Asana_ListProjects**
   - List workspace projects
   - Required: workspace_gid
   - Optional: opt_fields, archived
   - Endpoint: GET /workspaces/{workspace_gid}/projects

6. **Asana_SearchTasks**
   - Search tasks in workspace
   - Required: workspace_gid
   - Optional: text, assignee_gid, project_gid, completed, opt_fields
   - Endpoint: GET /workspaces/{workspace_gid}/tasks/search

### 4. Skill Playbook (4_skill_playbook.json)
- **Skill ID**: ASANA-SKILL-001
- **Skill Name**: Asana_Task_Manager
- **Version**: 1.0.0
- **Tools Used**: All 6 tools listed above

## Key Features

### Authentication
- Personal Access Token (PAT) based
- Bearer token in Authorization header
- Token stored securely in TENET.apiKey.asana

### Rate Limiting
- 1500 requests per minute limit
- Exponential backoff on 429 responses
- opt_fields parameter used to minimize payload

### Progressive Unlock
1. Project and task reading available immediately
2. Task creation/updates unlock after first retrieval
3. Task completion requires explicit Steward confirmation

## Constraints & Safeguards

1. **Security**: Never expose PAT in logs or outputs
2. **Rate Limiting**: Respect 1500 req/min; implement backoff
3. **Steward Confirmation**: Required for create/update operations
4. **Deduplication**: Always search before creating tasks
5. **Field Optimization**: Use opt_fields parameter for efficiency
6. **Sync Consistency**: Mirror WORK surface cards with Asana tasks
7. **Entity Storage**: Cache workspace_gid and project_gid in STREAM
8. **Format Validation**: Verify GID formats before API calls

## Playbook Steps

The skill execution follows 10 steps:
1. Input validation against schemas
2. Token retrieval and header construction
3. Intent determination (review/search/create/update/complete)
4. Project review with opt_fields optimization
5. Task listing with filtered responses
6. Task search with workspace scope
7. Task creation with deduplication check
8. Task updates with current state fetch
9. Task completion with Steward confirmation
10. Summary compilation and LTM storage

## Compatibility Formula
```
(project_management_interest * 3.0) + task_volume + (team_collaboration_need * 2.0)
```

## Integration Points

- **TENET**: API key storage (TENET.apiKey.asana)
- **STREAM**: Active GID caching (STREAM.entity)
- **WORK Surface**: Task synchronization
- **LTM**: Daily project summaries (asana_daily_{date})

## Example Usage

### List Projects
```json
{
  "tool": "Asana_ListProjects",
  "params": {
    "workspace_gid": "1234567890",
    "opt_fields": "gid,name,owner,archived,created_at"
  }
}
```

### Create Task
```json
{
  "tool": "Asana_CreateTask",
  "params": {
    "name": "Complete Q1 review",
    "projects": ["1234567890"],
    "assignee": "9876543210",
    "due_on": "2026-03-31",
    "notes": "Include performance metrics and feedback"
  }
}
```

### Search Tasks
```json
{
  "tool": "Asana_SearchTasks",
  "params": {
    "workspace_gid": "1234567890",
    "text": "urgent",
    "completed": false,
    "opt_fields": "gid,name,assignee,due_on"
  }
}
```

## API Documentation Reference
- Asana API Docs: https://developers.asana.com/reference
- v1.0 Endpoint: https://app.asana.com/api/1.0
- Auth Method: Bearer Token (Personal Access Token)

---
Generated: 2026-03-05
Integration Type: Project Management
Status: Verified
