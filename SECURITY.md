# Security Policy

## Supported versions

glancecard ships from its latest release. Security fixes land on the most
recent minor and are released as a patch. Please make sure you are on the
latest version before reporting: check the `uses: gfazioli/glancecard@…`
line of your workflow against the
[latest release](https://github.com/gfazioli/glancecard/releases/latest).

## Reporting a vulnerability

**Please do not open a public issue for security reports.**

Use GitHub's private vulnerability reporting instead:

1. Go to the [**Security** tab](https://github.com/gfazioli/glancecard/security) of the repository.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected version, and a reproduction if you have one.

You'll get a response as soon as possible. Once a fix is ready it will be
released and the advisory published with credit (unless you prefer to
stay anonymous).

## Scope

glancecard reads GitHub's API and writes SVG files. As an Action it runs
with the workflow's token, which needs `contents: write` to commit the
cards. Reports of particular interest:

- **Markup injection into a card.** Repository descriptions, topics,
  commit messages, release notes, names and logins are written into the
  SVG, escaped. A string that escapes that and adds elements, attributes
  or scripts to a card is worth reporting.
- **The token doing more than committing the cards.** The Action stages
  only the files it wrote and pushes to the checked-out branch; anything
  that commits other files, pushes elsewhere, or prints the token is in
  scope.
- **Private data on a public card.** Private repositories are refused
  unless `allow-private` is set, and the profile card counts public
  repositories only. Data from a private repository reaching a card
  without that setting is in scope.
- **Supply chain.** glancecard has no dependencies, at runtime or in
  development, and its CI pins third-party actions to commit SHAs.
