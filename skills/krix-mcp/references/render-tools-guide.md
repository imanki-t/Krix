# Krix MCP Render Tools Guide

This reference guide provides exhaustive documentation for the **21 Render Tools** in the Krix MCP toolset. These tools interact directly with Render cloud infrastructure, enabling workspace selection, web service and static site management, cron jobs, deployment tracking, environment variable management, log streaming, service metrics, and PostgreSQL querying.

---

## Tool Category & Activation
- **Category**: `render`
- **Activation**: Enable via lazy loading (`load_toolset({ category: "render" })`) or environment variable (`ENABLE_RENDER=true` or `ENABLE_RENDER_TOOLS=true`).

---

## Tool Index

1. [`list_workspaces`](#1-list_workspaces)
2. [`select_workspace`](#2-select_workspace)
3. [`get_selected_workspace`](#3-get_selected_workspace)
4. [`list_services`](#4-list_services)
5. [`get_service`](#5-get_service)
6. [`create_web_service`](#6-create_web_service)
7. [`create_static_site`](#7-create_static_site)
8. [`create_cron_job`](#8-create_cron_job)
9. [`restart_service`](#9-restart_service)
10. [`delete_service`](#10-delete_service)
11. [`list_deploys`](#11-list_deploys)
12. [`get_deploy`](#12-get_deploy)
13. [`trigger_deploy`](#13-trigger_deploy)
14. [`cancel_deploy`](#14-cancel_deploy)
15. [`list_logs`](#15-list_logs)
16. [`list_log_label_values`](#16-list_log_label_values)
17. [`get_metrics`](#17-get_metrics)
18. [`list_env_vars`](#18-list_env_vars)
19. [`update_env_vars`](#19-update_env_vars)
20. [`delete_env_var`](#20-delete_env_var)
21. [`query_render_postgres`](#21-query_render_postgres)

---

## Detailed Tool Descriptions

### Workspace Management
- **`list_workspaces`**: Lists accessible Render team workspaces and personal accounts.
- **`select_workspace`**: Selects the active Render workspace by `ownerID`.
- **`get_selected_workspace`**: Retrieves details for the currently active Render workspace.

### Services & Deployments
- **`list_services`**: Lists all services in the active workspace (`includePreviews` option).
- **`get_service`**: Gets detailed info for a specific Render service by `serviceId`.
- **`create_web_service`**: Deploys a web service on Render with runtime, repo, build/start commands, plan, and environment variables.
- **`create_static_site`**: Deploys a static site on Render from a Git repo.
- **`create_cron_job`**: Creates a scheduled cron job on Render.
- **`restart_service`**: Restarts an active Render web service or worker.
- **`delete_service`**: Deletes a Render service.
- **`list_deploys`**: Lists deployment history for a service.
- **`get_deploy`**: Gets deployment status and logs for a specific `deployId`.
- **`trigger_deploy`**: Triggers a manual deployment for a service (`clearCache` option).
- **`cancel_deploy`**: Cancels an in-progress deployment.

### Logs, Metrics & Environment Variables
- **`list_logs`**: Streams or retrieves application logs for a Render service.
- **`list_log_label_values`**: Lists label values (instance IDs, component names) for log filtering.
- **`get_metrics`**: Fetches CPU, memory, and bandwidth utilization metrics for a service.
- **`list_env_vars`**: Lists environment variables configured on a service.
- **`update_env_vars`**: Creates or updates environment variables on a service.
- **`delete_env_var`**: Deletes an environment variable from a service.

### Database Operations
- **`query_render_postgres`**: Executes SQL queries directly against a Render PostgreSQL database instance.
