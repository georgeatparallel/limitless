---
name: add-parallel-search
description: Install free anonymous Parallel web search and page fetching in the NanoClaw agent runtime.
---

# Add Parallel Search

Install the feature branch with executable agent-runner support for
[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp).
Search uses Fast mode. No Parallel account or API key is required.

## 1. Merge the feature branch

Start with a clean working tree. From the LIMITLESS monorepo, fetch and merge
the maintained feature branch:

```bash
git fetch origin skill/parallel-search
git merge --no-ff origin/skill/parallel-search
```

Use the remote for `LIMITLESS-LONGEVITY/limitless` if it is named differently.
If the branch is unavailable, stop and ask the maintainer for the extracted
feature branch. Do not replace this step with manual edits to the runner.
Resolve merge conflicts by preserving the user's existing MCP servers, tool
permissions, credentials and other customizations.

## 2. Check existing search choices

The installed runtime adds `parallel-search` to the real Claude Agent SDK MCP
dispatcher. On an unconfigured installation it supplies `web_search` and
`web_fetch`, and disables Claude's built-in WebSearch/WebFetch for that query.
An MCP failure is reported through the SDK; it does not select another provider.

Existing Claude settings and MCP registrations take priority. The resolver
conservatively leaves web access unchanged if it finds custom Claude settings
beyond the generated session environment, existing MCP configuration, or saved
search credentials. It never edits those files or adds permission grants to an
existing policy. Malformed saved configuration stops initialization rather than
enabling a different provider. The existing authenticated `/add-parallel` skill
and Task API setup are separate and remain available.

One host-wide setting in `apps/nanoclaw/.env` applies to every group:

| `NANOCLAW_WEB_SEARCH` | Behavior |
|---|---|
| `auto` (default) | Use anonymous Parallel when no saved search setup exists. A configured `PARALLEL_API_KEY` keeps the existing setup. |
| `parallel` | Request anonymous Parallel even if the host has a Parallel key. Saved SDK configuration and permissions still take priority. |
| `claude` | Keep Claude WebSearch/WebFetch and the existing MCP setup. |
| `off` | Disable this skill's MCP tools and the bundled WebSearch/WebFetch tools. Independently configured third-party servers remain under their existing settings. |

Do not change the user's choice automatically. No credentials are copied into
containers by this skill. Custom MCP servers can be configured through Claude's
existing settings instead of the anonymous default.

## 3. Build and restart

From `apps/nanoclaw`:

```bash
npm install --legacy-peer-deps --package-lock=false
npm run build
npm test
npm --prefix container/agent-runner ci
npm --prefix container/agent-runner test
./container/build.sh
```

Restart the existing NanoClaw service using its normal service manager, then
start a new conversation. Do not deploy directly to a managed LIMITLESS VPS;
follow its PR and human-ratification process.

## 4. Verify the assistant

Ask the assistant for a recent factual lookup with source URLs, then ask it to
fetch one of those pages. Confirm that `mcp__parallel-search__web_search` and
`mcp__parallel-search__web_fetch` run and their results reach the final response.
Also verify a configured `claude` or `off` choice stays in effect after restart.

Anonymous use has service limits. A quota response is an error, not a search
result; report it to the user without switching providers. Inference still uses
the user's existing Claude setup.

## Remove the skill

Revert the feature-branch merge with `git revert -m 1 <merge-commit>`, resolve any
conflicts while retaining later user edits, rebuild the container and host, and
restart the service. To keep the code installed but use the previous web tools,
set the host-wide choice to `claude` instead.
