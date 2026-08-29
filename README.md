# AccessiFix

An accessibility code-review agent. Connect a GitHub repository and its deployed URL. AccessiFix audits the live site against all 55 WCAG 2.2 Level AA success criteria, writes fixes into the source, proves the fixes did not break the application, and opens a pull request.

Every existing accessibility tool inspects a page in one state. AccessiFix drives the interface through its state transitions and reads the accessibility tree on both sides of every interaction. Twelve of the 55 criteria are only observable that way.

Built on [TrueForge](https://trueforge.dev) for the Agent Harness Hackathon.

## Status

In development.
