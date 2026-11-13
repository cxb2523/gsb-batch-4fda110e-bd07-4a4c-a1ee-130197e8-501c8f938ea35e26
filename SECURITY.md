# Security Policy

## Supported Versions

Security fixes are generally applied to the latest version of WikiCrawl.

| Version | Supported |
| ------- | --------- |
| Latest | Yes |
| Older versions | No |

If you discover a security issue affecting an older version, please verify whether the issue is also present in the latest version before reporting it.

---

## Reporting a Vulnerability

If you believe you have found a security vulnerability in WikiCrawl, please report it privately rather than opening a public GitHub issue.

Publicly disclosing a vulnerability before it has been investigated may put users and the project at unnecessary risk.

### Please Include

When reporting a vulnerability, provide as much of the following information as possible:

- A clear description of the vulnerability
- The affected component or functionality
- Steps to reproduce the issue
- The potential impact
- Any proof-of-concept code or screenshots, if applicable
- The environment in which the issue was discovered
- Any suggested mitigation, if you have one

A useful report should allow the issue to be reproduced and understood without requiring significant additional investigation.

---

## Where to Report

For security vulnerabilities, please use GitHub's private vulnerability reporting functionality:

**GitHub → Security → Advisories → Report a vulnerability**

Do **not** create a public GitHub issue for an undisclosed security vulnerability.

If private vulnerability reporting is unavailable for the repository, contact the project maintainer privately through the contact information associated with the repository.

---

## What Qualifies as a Security Vulnerability?

Examples include, but are not limited to:

- Authentication or authorization bypasses
- Exposure of API keys, tokens, or other secrets
- Server-side request forgery (SSRF)
- Cross-site scripting (XSS)
- Injection vulnerabilities
- Sensitive information disclosure
- Insecure handling of user-controlled input
- Unauthorized access to backend resources
- Vulnerabilities that allow arbitrary code execution
- Security issues involving third-party API credentials
- Significant denial-of-service vulnerabilities

If you are unsure whether something qualifies as a security vulnerability, it is better to report it privately.

---

## Out of Scope

The following generally do not qualify as security vulnerabilities unless they demonstrate a meaningful security impact:

- General bugs without a security implication
- UI/UX issues
- Feature requests
- Performance issues without a security impact
- Spam
- Social engineering
- Issues requiring physical access to a user's device
- Vulnerabilities in third-party services that are not caused by WikiCrawl
- Reports based solely on outdated software versions when the issue is already fixed in the latest version
- Automated scanner reports without a demonstrated security impact

Please use GitHub Issues for ordinary bugs and feature requests.

---

## Responsible Disclosure

Please give the maintainers a reasonable opportunity to investigate and address a reported vulnerability before publicly disclosing it.

We ask security researchers to:

- Avoid accessing or modifying data that does not belong to them
- Avoid disrupting the availability of WikiCrawl or its infrastructure
- Avoid deleting or modifying other users' data
- Avoid exploiting a vulnerability beyond what is necessary to demonstrate it
- Avoid publicly disclosing the vulnerability before it has been addressed

If you unintentionally access sensitive information while testing, stop testing that portion of the vulnerability and report what happened.

---

## Security Research Guidelines

Security research is welcome when conducted responsibly.

Please use test accounts and non-sensitive data whenever possible.

Do not perform testing that could:

- Cause significant service degradation
- Generate excessive traffic
- Destroy or modify production data
- Access private user information
- Circumvent security controls for purposes unrelated to demonstrating the vulnerability

If a vulnerability can be demonstrated without performing a destructive action, please use the non-destructive approach.

---

## Secrets and Credentials

Never commit secrets to the repository.

This includes:

- API keys
- Access tokens
- Private keys
- Database credentials
- Service credentials
- Authentication tokens
- Production environment variables

Use environment variables or the project's configured secret-management system instead.

If you accidentally commit a secret:

1. Revoke or rotate the credential immediately.
2. Remove the secret from the repository.
3. Investigate whether the credential was accessed.
4. Report the incident privately if it may have affected WikiCrawl or its users.

Removing a secret from the latest commit does not necessarily make it secure. Credentials exposed in Git history should be considered compromised and rotated.

---

## Dependencies

WikiCrawl relies on third-party libraries and services.

Dependencies should be kept reasonably up to date, particularly when security vulnerabilities are disclosed.

When adding a dependency:

- Prefer well-maintained projects
- Review the dependency's security history
- Avoid unnecessary dependencies
- Keep dependency versions reproducible
- Remove dependencies that are no longer required

---

## Third-Party Services

WikiCrawl may rely on external services such as Wikipedia and infrastructure or analytics providers.

Security issues originating entirely within a third-party service should generally be reported to that service's security team.

However, if WikiCrawl's implementation creates or exposes the vulnerability, please report it to the WikiCrawl maintainers as well.

---

## Security Updates

When a confirmed vulnerability is resolved, the project may publish a security advisory containing:

- A description of the vulnerability
- The affected versions
- The fixed version
- The severity or impact
- Recommended actions for users

Details that could enable exploitation may be withheld until an appropriate fix or mitigation is available.

---

## Acknowledgements

We appreciate responsible security researchers who help improve WikiCrawl.

Where appropriate, contributors who responsibly disclose valid security vulnerabilities may be acknowledged after the issue has been resolved, subject to their preference and the circumstances of the disclosure.

---

## Questions

For general questions about WikiCrawl, please use GitHub Issues or Discussions.

For potential security vulnerabilities, **please use private vulnerability reporting instead of public discussion.**

Thank you for helping keep WikiCrawl and its users secure.
