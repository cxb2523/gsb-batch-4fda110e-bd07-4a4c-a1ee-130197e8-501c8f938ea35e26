# Contributing to WikiCrawl

Thank you for considering contributing to WikiCrawl.

WikiCrawl is an interactive knowledge graph and web crawler that turns Wikipedia's connected articles into an explorable graph. The goal is to make discovering relationships between topics more intuitive, visual, and enjoyable.

Whether you're fixing a bug, improving the graph experience, optimizing the crawler, improving accessibility, or suggesting a new feature — contributions are welcome.

---

## Table of Contents

- [Before You Start](#before-you-start)
- [Ways to Contribute](#ways-to-contribute)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Project Guidelines](#project-guidelines)
- [UI and UX Guidelines](#ui-and-ux-guidelines)
- [Code Guidelines](#code-guidelines)
- [Commit Messages](#commit-messages)
- [Pull Requests](#pull-requests)
- [Reporting Bugs](#reporting-bugs)
- [Feature Requests](#feature-requests)
- [Questions and Discussions](#questions-and-discussions)
- [Code of Conduct](#code-of-conduct)
- [License](#license)

---

## Before You Start

Before making a contribution:

1. Check the existing issues and pull requests.
2. Search the repository to make sure the problem or feature hasn't already been addressed.
3. For significant changes, open an issue first to discuss the proposed approach.
4. Keep pull requests focused on one problem or feature whenever possible.

For small fixes such as typos, documentation improvements, or obvious bugs, you can usually submit a pull request directly.

---

## Ways to Contribute

There are many ways to contribute to WikiCrawl.

### Code

- Fix bugs
- Improve crawler reliability
- Improve graph generation
- Optimize performance
- Improve error handling
- Improve responsive behavior
- Improve accessibility
- Add tests
- Improve the development experience

### User Experience

- Improve graph exploration
- Make relationships between nodes clearer
- Improve navigation
- Improve mobile usability
- Improve loading and empty states
- Improve accessibility
- Suggest better interaction patterns

### Documentation

- Improve the README
- Add technical documentation
- Improve setup instructions
- Add examples
- Fix inaccurate or outdated documentation

### Ideas and Feedback

You can also contribute by:

- Reporting bugs
- Suggesting features
- Sharing usability feedback
- Testing new functionality
- Sharing WikiCrawl with people who may find it useful


# Getting Started

## Prerequisites

Make sure you have the following installed:

- Node.js
- npm
- Git

Check your versions with:

```bash
node --version
npm --version
git --version
```

---

## Fork the Repository

Fork the WikiCrawl repository on GitHub and clone your fork:

```bash
git clone https://github.com/Adityavardhanjain/WikiCrawl.git
cd WikiCrawl
```

Add the upstream repository:

```bash
git remote add upstream https://github.com/Adityavardhanjain/WikiCrawl.git
```

Verify your remotes:

```bash
git remote -v
```

---

## Install Dependencies

Install the project dependencies:

```bash
npm install
```

---

## Environment Variables

If the project requires environment variables, create a local environment file based on the variables documented in the repository.

Do **not** commit:

- API keys
- Secrets
- Tokens
- Private credentials
- Production environment variables

Never add `.env` files containing secrets to Git.

---

## Run WikiCrawl Locally

Start the development server:

```bash
npm run dev
```

Then open the local development URL shown in your terminal.

Before submitting a pull request, make sure the application works correctly in a clean development environment.

---

# Development Workflow

A typical contribution workflow looks like this:

```text
Fork
  ↓
Clone
  ↓
Create branch
  ↓
Make changes
  ↓
Run tests / checks
  ↓
Review changes
  ↓
Commit
  ↓
Push
  ↓
Open Pull Request
```

Create a feature branch rather than working directly on `main`:

```bash
git checkout -b feature/your-feature-name
```

For bug fixes:

```bash
git checkout -b fix/your-bug-name
```

For documentation:

```bash
git checkout -b docs/your-change
```

---

# Project Guidelines

WikiCrawl is primarily an exploration tool. Contributions should preserve the core experience of discovering connections between topics.

When making changes, consider:

### Performance

WikiCrawl can generate large graphs.

Avoid introducing unnecessary:

- Network requests
- Re-renders
- Data processing
- Memory usage
- Client-side computation

If a change affects graph generation or rendering performance, test it with larger graphs as well as small ones.

### Reliability

Crawler failures should be handled gracefully.

Prefer:

- Clear error states
- Useful user feedback
- Defensive handling of unexpected data
- Graceful handling of unavailable Wikipedia pages
- Safe handling of malformed or incomplete responses

Avoid silently failing operations where the user would have no indication of what happened.

### Backward Compatibility

Do not unnecessarily break existing functionality.

If a change requires modifying an existing API, data structure, or behavior, explain the reason and impact in the pull request.

---

# UI and UX Guidelines

WikiCrawl's interface is intentionally designed around exploration.

Contributions to the UI should prioritize:

1. **Clarity**
2. **Speed**
3. **Discoverability**
4. **Accessibility**
5. **Consistency**
6. **Responsiveness**

The interface should remain easy to understand even as the graph becomes more complex.

### Avoid Unnecessary UI Complexity

Do not add UI elements simply because they look interesting.

Every interaction should have a clear purpose.

### Preserve Graph Exploration

Changes should not make it harder for users to:

- Understand the graph
- Select nodes
- Explore relationships
- Read article information
- Navigate between states
- Return from an opened node or panel

### Mobile Matters

Any UI contribution should be tested on smaller screens.

A feature that works on desktop but makes the application difficult to use on mobile is not considered complete.

### Accessibility

Where applicable:

- Use semantic HTML
- Provide accessible labels
- Maintain keyboard navigation
- Ensure interactive elements are discoverable
- Avoid relying solely on color to communicate information
- Consider reduced-motion preferences

---

# Code Guidelines

Follow the existing conventions in the repository.

Prefer:

- Small, focused components
- Reusable utilities
- Clear naming
- Simple control flow
- Explicit error handling
- Minimal duplication

Avoid:

- Large unrelated refactors
- Dead code
- Unused dependencies
- Unnecessary abstractions
- Hardcoded secrets
- Debugging statements in production code

Before committing, remove temporary debugging code such as:

```javascript
console.log(...)
```

unless it is intentionally part of the application's behavior.

---

# Dependencies

Do not add a dependency for functionality that can reasonably be implemented using the existing stack.

If you believe a new dependency is necessary:

1. Explain why it is needed.
2. Consider its bundle size and maintenance status.
3. Check whether the existing project already provides equivalent functionality.
4. Mention the dependency in the pull request.

---

# Commit Messages

Keep commit messages short and descriptive.

Good examples:

```text
fix: improve mobile node navigation
```

```text
feat: add relationship details to graph nodes
```

```text
perf: reduce unnecessary graph re-renders
```

```text
docs: improve local development instructions
```

```text
fix: handle failed Wikipedia requests
```

Avoid vague messages such as:

```text
update
```

```text
changes
```

```text
fixed stuff
```

```text
final
```

---

# Pull Requests

Before opening a pull request, make sure:

- [ ] The application runs locally
- [ ] The change works as intended
- [ ] Existing functionality still works
- [ ] Tests/checks pass, where applicable
- [ ] No secrets or credentials were committed
- [ ] No unnecessary dependencies were added
- [ ] Mobile behavior has been considered for UI changes
- [ ] The code follows the existing project conventions
- [ ] Documentation has been updated if necessary

## Pull Request Description

Please explain:

### What changed?

Briefly describe the implementation.

### Why?

Explain the problem the change solves or the motivation behind it.

### How was it tested?

Describe the testing you performed.

For UI changes, screenshots or short recordings are highly encouraged.

### Example

```markdown
## What changed?

Improved the node details panel so users can better understand how
the selected article connects to neighboring nodes.

## Why?

Users could see that nodes were connected but had limited information
about the relationship between them.

## Testing

- Tested locally with small graphs
- Tested with larger crawls
- Tested desktop layout
- Tested mobile layout

## Screenshots

[Add screenshots here]
```

---

# Reporting Bugs

If you find a bug, please open an issue with enough information to reproduce it.

Include:

### Description

What happened?

### Expected Behavior

What did you expect to happen?

### Steps to Reproduce

Provide the smallest set of steps that reliably reproduces the issue.

Example:

```text
1. Open WikiCrawl
2. Search for "Artificial Intelligence"
3. Start a crawl at depth 3
4. Select a node
5. Open the relationship panel
6. Observe...
```

### Environment

Where did the issue occur?

For example:

```text
Browser: Chrome 153
OS: Arch Linux
Device: Desktop
```

For mobile issues, include:

```text
Device:
Browser:
Screen size:
```

### Screenshots / Videos

If the issue is visual or interaction-related, screenshots or screen recordings are very helpful.

---

# Feature Requests

Before proposing a feature, consider whether it improves the core WikiCrawl experience.

A good feature request should explain:

- What problem does this solve?
- Who benefits from it?
- How would the feature work?
- Why is the current behavior insufficient?
- Are there alternative approaches?

Please avoid proposing features solely because they are technically interesting.

WikiCrawl should remain focused on **knowledge exploration through connected information**.

---

# Questions and Discussions

If you're unsure about an implementation, open an issue or discussion before investing significant time in a large change.

For larger architectural changes, early discussion is strongly preferred.

This helps avoid situations where significant work has been completed around an approach that doesn't fit the project's direction.

---

# Code of Conduct

Please be respectful and constructive.

Contributors are expected to:

- Treat others with respect
- Give constructive feedback
- Assume good intentions
- Keep discussions relevant
- Avoid harassment or discriminatory behavior

Disagreements about implementation are normal. Keep technical discussions focused on the problem and the proposed solution.

---

# License

By contributing to WikiCrawl, you agree that your contributions will be licensed under the same license as the project.

See the repository's `LICENSE` file for the applicable license terms.

---

# Thank You

Every contribution helps improve WikiCrawl.

Whether you submit code, report a bug, improve documentation, test a feature, or simply share an idea, your contribution helps make knowledge exploration better.

**Explore. Connect. Discover.**
```
