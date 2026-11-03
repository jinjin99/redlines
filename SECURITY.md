# Security

redlines runs on your machine against apps you run, and some of what it keeps is sensitive:

- **Logins** (`.redlines/auth/`): a browser's cookies and local storage after you logged in. Treat them as credentials.
- **Recordings** (`record_data`, `data_proxy`): your backend's real answers, which may hold personal data or tokens.
- **The data proxy's certificate authority** (`.redlines/proxy-ca/`): its key could be used to read HTTPS traffic of a process told to trust it. Only the dev server you start with `NODE_EXTRA_CA_CERTS` trusts it.

redlines writes all of these under `.redlines/`, which it gives a `.gitignore` of its own, and keeps key and login files readable by you only. Don't publish them, and don't commit a recording to a public repository.

## Reporting a vulnerability

Please report security issues privately through GitHub's [private vulnerability reporting](https://github.com/jinjin99/redlines/security/advisories/new) rather than in a public issue. You'll get a reply within a week.
