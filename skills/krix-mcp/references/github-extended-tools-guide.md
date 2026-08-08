# Krix MCP Extended GitHub Tools Guide (Issues, PRs, Reviews & Admin)

This reference guide provides exhaustive documentation for the **32 Extended GitHub Tools** in the Krix MCP toolset. These tools cover Issues management, Pull Request reviews & merging, team management, releases, tags, secret scanning, and Copilot code reviews.

---

## Tool Categories & Activation
- **Issues & PRs (`github_issues_prs`)**: Enable via `load_toolset({ category: "github_issues_prs" })` or environment variable `ENABLE_GITHUB_ISSUES_PRS=true`.
- **Extended & Admin (`github_admin`)**: Enable via `load_toolset({ category: "github_admin" })` or environment variable `ENABLE_GITHUB_ADMIN=true`.

---

## Tool Index

### A. Issues & Pull Request Workflows (`github_issues_prs`)
1. [`list_issues`](#1-list_issues)
2. [`list_pull_requests`](#2-list_pull_requests)
3. [`issue_read`](#3-issue_read)
4. [`issue_write`](#4-issue_write)
5. [`sub_issue_write`](#5-sub_issue_write)
6. [`add_issue_comment`](#6-add_issue_comment)
7. [`pull_request_read`](#7-pull_request_read)
8. [`pull_request_review_write`](#8-pull_request_review_write)
9. [`add_comment_to_pending_review`](#9-add_comment_to_pending_review)
10. [`add_reply_to_pull_request_comment`](#10-add_reply_to_pull_request_comment)
11. [`update_pull_request`](#11-update_pull_request)
12. [`update_pull_request_branch`](#12-update_pull_request_branch)
13. [`merge_pull_request`](#13-merge_pull_request)
14. [`search_issues`](#14-search_issues)
15. [`search_pull_requests`](#15-search_pull_requests)

### B. Extended & Admin Operations (`github_admin`)
16. [`get_label`](#16-get_label)
17. [`get_release`](#17-get_release)
18. [`get_tag`](#18-get_tag)
19. [`get_team_members`](#19-get_team_members)
20. [`get_teams`](#20-get_teams)
21. [`list_commits`](#21-list_commits)
22. [`list_issue_fields`](#22-list_issue_fields)
23. [`list_issue_types`](#23-list_issue_types)
24. [`list_releases`](#24-list_releases)
25. [`list_repository_collaborators`](#25-list_repository_collaborators)
26. [`list_tags`](#26-list_tags)
27. [`search_users`](#27-search_users)
28. [`run_secret_scanning`](#28-run_secret_scanning)
29. [`create_repository`](#29-create_repository)
30. [`fork_repository`](#30-fork_repository)
31. [`request_copilot_review`](#31-request_copilot_review)
32. [`assign_copilot_to_issue`](#32-assign_copilot_to_issue)

---

## Detailed Tool Descriptions

### Issues & Pull Requests (`github_issues_prs`)
- **`list_issues`**: Lists issues filtered by state, label, assignee, or milestone.
- **`list_pull_requests`**: Lists pull requests in the target repository.
- **`issue_read`**: Reads issue details, comments, hierarchy, or labels.
- **`issue_write`**: Creates or updates repository issues.
- **`sub_issue_write`**: Attaches or manages parent-child issue relationships.
- **`add_issue_comment`**: Adds comments or reactions to issues and pull requests.
- **`pull_request_read`**: Retrieves PR metadata, diffs, commits, reviews, or check runs.
- **`pull_request_review_write`**: Creates, submits, or resolves PR reviews and threads.
- **`add_comment_to_pending_review`**: Adds line-level comments to a pending review.
- **`add_reply_to_pull_request_comment`**: Replies to review comments.
- **`update_pull_request`**: Updates PR title, description, base branch, or state.
- **`update_pull_request_branch`**: Updates a PR branch with latest changes from base.
- **`merge_pull_request`**: Merges a pull request using squash, rebase, or merge commits.
- **`search_issues`**: Searches issues using GitHub issues search syntax.
- **`search_pull_requests`**: Searches pull requests using GitHub search syntax.

### Extended & Admin Operations (`github_admin`)
- **`get_label`**: Retrieves label metadata from a repository.
- **`get_release`**: Retrieves release details by tag or latest release.
- **`get_tag`**: Gets git tag information.
- **`get_team_members`**: Lists usernames of organization team members.
- **`get_teams`**: Lists organization teams for the authenticated user.
- **`list_commits`**: Lists commits on a branch with filtering by author/date/path.
- **`list_issue_fields`**: Lists custom issue fields for an organization or repo.
- **`list_issue_types`**: Lists supported issue types.
- **`list_releases`**: Lists repository releases.
- **`list_repository_collaborators`**: Lists collaborators and permissions.
- **`list_tags`**: Lists git tags in a repository.
- **`search_users`**: Searches GitHub users.
- **`run_secret_scanning`**: Scans files/snippets for exposed API keys and secrets.
- **`create_repository`**: Creates a new repository under personal account or org.
- **`fork_repository`**: Forks a target repository.
- **`request_copilot_review`**: Requests automated GitHub Copilot code review on a PR.
- **`assign_copilot_to_issue`**: Assigns GitHub Copilot to work on an issue.
