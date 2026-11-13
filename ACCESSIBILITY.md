# Accessibility

WikiCrawl is designed to make exploring connected knowledge accessible to as many people as possible.

Accessibility matters because the core WikiCrawl experience involves interacting with a visual knowledge graph, navigating between articles, reading information, and exploring relationships. These interactions should remain usable across different devices, input methods, and abilities.

This document describes WikiCrawl's accessibility priorities, expectations for contributors, known limitations, and how to report accessibility barriers.

## Priorities

WikiCrawl prioritizes:

- Clear and understandable navigation
- Keyboard-accessible interactions where practical
- Readable text and sufficient visual contrast
- Responsive experiences across desktop and mobile devices
- Accessible controls and interactive elements
- Meaningful labels for buttons and other controls
- Clear focus states
- Usable error, loading, and empty states
- Reduced reliance on color alone to communicate information
- Accessible alternatives to important visual information where practical

The knowledge graph is inherently visual and interactive. We aim to provide meaningful ways to access important information represented by the graph even when a user cannot interact with it in the same way as a mouse or touchscreen user.

WikiCrawl aims to move toward strong accessibility practices and alignment with widely accepted accessibility guidelines. No specific level of WCAG conformance is currently claimed or formally verified.

## Contributor expectations

Accessibility should be considered whenever a contribution changes the user interface or interaction model.

Contributors should:

- Prefer semantic HTML where appropriate.
- Ensure interactive elements can be identified and operated clearly.
- Preserve or provide visible keyboard focus states.
- Use descriptive labels for controls that may not have visible text.
- Avoid using color as the only way to communicate important information.
- Consider keyboard navigation when adding interactive functionality.
- Consider screen-reader users when introducing new controls or navigation patterns.
- Ensure text remains readable at different screen sizes.
- Consider reduced-motion preferences when adding animations.
- Test responsive changes on smaller screens.
- Avoid introducing inaccessible custom controls when a native HTML control is suitable.

For user-facing accessibility changes, pull requests should explain how the change was tested.

Screenshots, screen recordings, or other supporting evidence are encouraged for visual or interaction changes but are not required.

Do not claim that a feature is accessible or WCAG-compliant unless it has actually been evaluated to support that claim.

## Reporting accessibility issues

If you encounter an accessibility barrier while using WikiCrawl, please report it through the project's GitHub issue tracker.

When possible, include:

- The page or feature where the problem occurred
- What you were trying to accomplish
- What happened
- What you expected to happen
- Browser and version
- Operating system
- Device type
- Input method, such as keyboard, mouse, touch, or other assistive input
- Assistive technology being used, if applicable

For example:

```text
I was trying to open a node from the graph using only my keyboard.

Expected:
I expected to be able to focus the node and activate it with Enter.

Observed:
The node could only be selected using a mouse.

Browser: Chrome 153
OS: Linux
Input: Keyboard
