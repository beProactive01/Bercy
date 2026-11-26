# Planning guide

Design the workflow that will deliver the requested result. Each node needs an owner, a concrete output, the inputs it depends on and a way to tell when the work is complete. Bercy supplies the JSON format. Project-specific instructions take precedence over this guide.

## Decide what the user wants

| Request | Delivery |
| --- | --- |
| Write, summarize, research, evaluate or plan | Return the text directly |
| Build an app, website, game, tool or script | Deliver a working shared project directory |
| Create a picture, recording or video | Deliver the media file |
| Explain a result and supply supporting files | Return text and attachments |

Honor an explicit scope and output language. If the requested scope exceeds what can be built, choose the largest credible working result. For example, deliver a playable ten-minute section of a game or a working purchase flow. Have the first node state what will be built, its limits, the technology, the run instructions and its acceptance criteria.

## Choose the shape of the workflow

Use one node when it can do the job well. Split work when parts can run in parallel, require distinct capabilities, exceed one agent's reliable context or warrant independent verification. A typical plan has one to six nodes. Larger projects may grow during execution.

- Give each node one independently verifiable result. Name it for its work or artifact, such as “Approval API” or “Regression checklist”.
- Connect only the inputs a node uses. It waits for **all** its declared inputs. A synthesis node must depend on every contribution it needs.
- Unrelated deliverables can finish on separate branches. Add a final synthesis only when the user needs a combined result.
- Use a review node to inspect its single upstream result. It can send specific issues back for up to two rounds.
- A review node runs on a different runtime from its upstream when one is connected. For example, Codex implements and Claude reviews, so a second model catches what the first one misses. Add a review where a mistake is costly, such as code, data conclusions or customer-facing copy.
- Avoid nodes whose only purpose is to relay a message, report progress or reformat another node's output.

## Write a brief that stands on its own

The executor sees its brief, supplied materials and shared project conventions. Start with a verb. State the scope, input assumptions, expected format and acceptance criteria. Keep coordination instructions out of the brief.

For example, an approval API brief can require two sequential approvals, a reason for rejection, named endpoints and passing tests for approval, rejection and repeat submissions. A research brief can require dated sources. When asked to open and verify a public source, require an HTTP read with a short supporting excerpt in the tool output. Include both shell and network when using a command to fetch the text. A code brief can require running a specific check. For writing tasks, request the final text directly. For project work, specify the paths and interfaces the executor owns.

## Plan a shared project

Project nodes work in the same directory. Define the following before assigning parallel implementation.

1. List each top-level path and purpose. A small web tool might use README.md, docs/scope.md, server/core/, feature-specific server directories, web/ and tests/.
2. Set conventions for languages and versions, naming, public interfaces, resources, build commands and tests.
3. Give instructions for running from a clean checkout and one reliable acceptance command that exits with zero on success. Leave the command empty if the result needs a human check.
4. Assign nonoverlapping writable paths to parallel nodes. Let a foundation node build the entry point, configuration and shared modules first. Integration owns any necessary cross-module edits.
5. Prefer locally runnable technology with few dependencies. Choose resources that can be generated locally when accounts, paid services or special hardware are unavailable.
6. End with an integration and acceptance node that depends on every implementation branch. It connects modules, exercises the main user journey, fixes integration problems and finishes the README. A multi-input integration node can fix issues directly. Review nodes require a single input.

## Expand only when it helps

Mark a node as expandable when its output will identify pieces of work that need separate implementation, such as a module map, chapter outline or test matrix. A plan usually needs zero or one expandable node, with at most two. Ordinary implementation, synthesis and review nodes should stay fixed.

After the breakdown arrives, proceed with the existing graph if one node can finish the remaining work. Each expansion adds at most six nodes across a maximum depth of two. Give each new node its relevant details from the breakdown, its paths and its own acceptance criteria. Independent paths must stay disjoint. Downstream integration waits for the new nodes. Include integration if the original workflow lacks it.

## Choose delivery and runtime

Use text for articles, plans, analyses and checklists. Use file delivery when the requested result is itself a file, mixed for text with attachments, or project for a runnable multi-file result. Mark shell access for scripts, builds and tests. Mark network access for fresh research. Prefer a connected runtime whose capabilities and strengths match the task. Leave the preference empty when uncertain. One runtime can serve multiple roles.

## Worked examples

| Request | Suggested workflow |
| --- | --- |
| Rewrite a product introduction for older readers in fewer than 500 words | One writing node returns the finished copy. |
| Prepare subscription release notes, a support FAQ and regression tests | Three independent branches. Attach a review to the regression list covering renewals, cancellations, refunds and older clients. |
| Compare permissions, offline support and pricing across three collaboration tools | Research each product in parallel with dated sources, then compare all three and give a recommendation. |
| Explain declining sales using the attached data and include charts | Run an analysis script and deliver findings with charts. Base recommendations on the computed results. |
| Build an expense approval tool | Define scope, build a runnable foundation, implement submission, approvals, reporting and UI in parallel, then test the full journey. |
| Build a learning platform | Define a usable first version, establish the architecture, then let an expandable module plan assign implementation. Integrate and test the instructor-to-learner journey. |
