# Kroonenburg Family Office

The public website for the Kroonenburg Family Office: a landing page, a profile
page for each of the three principals, and a contact page backed by a serverless
API on AWS.

> **Placeholder content.** The team names, biographies, credentials, email
> address and office hours in these pages are invented stand-ins so the site is
> complete and reviewable. Replace them with real details before pointing a
> public domain at this.

## Pages

| Path                            | Purpose                                        |
| ------------------------------- | ---------------------------------------------- |
| `/`                             | Landing page — what the office does, team, CTA |
| `/team/executive-assistant.html`| Executive Assistant profile                    |
| `/team/cfo.html`                | Chief Financial Officer profile                |
| `/team/chief-counsel.html`      | Chief Counsel profile                          |
| `/contact.html`                 | Contact form and office details                |

The front end is hand-written HTML and CSS with one small progressive-enhancement
script. There is no framework, no build step and no client-side routing, so every
page is served as static HTML straight from the CDN.

## Architecture

```
GitHub (this repo)
  │
  ├─ push ──▶ AWS Amplify Hosting ──▶ CloudFront ──▶ static pages, CSS, JS
  │
  └─ push ──▶ GitHub Actions ──▶ AWS SAM ──▶ API Gateway (HTTP API)
                                               └▶ Lambda (contact handler)
                                                    ├▶ DynamoDB  (enquiry record, TTL)
                                                    └▶ SES       (notify the office)
```

Everything is serverless and scales to zero: Amplify Hosting for the static
tier, and an HTTP API in front of a single Lambda for the only dynamic thing on
the site — the contact form.

### Repository layout

```
index.html                        landing page
contact.html                      contact page
team/                             one page per principal
assets/css/site.css               shared stylesheet
assets/js/contact.js              contact form submission + validation
amplify.yml                       Amplify build, artifact and header config
infrastructure/template.yaml      SAM template for the contact API
infrastructure/src/contact/       Lambda handler and its tests
scripts/check-links.mjs           internal link/anchor checker (runs in CI)
.github/workflows/                CI checks and backend deployment
```

## Local development

Any static file server works. From the repository root:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

While `window.KFO_CONTACT_API` is empty (its default in `contact.html`), the
contact form validates input and then falls back to opening a pre-filled
`mailto:` draft, so the page is never a dead end before the backend exists.

Checks:

```bash
node scripts/check-links.mjs          # every internal link and anchor resolves
cd infrastructure && npm install && npm test   # contact handler tests
```

## Deploying the contact API

Prerequisites: the AWS SAM CLI, credentials for the target account, and an SES
identity verified in the same region as the stack. While the account is in the
SES sandbox the recipient address must be verified too.

```bash
cd infrastructure
sam build
sam deploy --guided \
  --stack-name kroonenburg-contact-api \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    SenderEmail=no-reply@kroonenburg.capital \
    RecipientEmail=office@kroonenburg.capital \
    AllowedOrigins=https://kroonenburg.capital,https://www.kroonenburg.capital
```

Take the `ContactApiEndpoint` output and set it in `contact.html`:

```html
<script>
  window.KFO_CONTACT_API = "https://abc123.execute-api.eu-west-1.amazonaws.com/prod";
  window.KFO_CONTACT_EMAIL = "office@kroonenburg.capital";
</script>
```

Commit that change; Amplify redeploys the site on push.

### Template parameters

| Parameter                | Default | Notes                                               |
| ------------------------ | ------- | --------------------------------------------------- |
| `SenderEmail`            | —       | Verified SES identity mail is sent from              |
| `RecipientEmail`         | —       | Mailbox that receives enquiries                      |
| `AllowedOrigins`         | `*`     | Comma-separated site origins; set this in production |
| `RetentionDays`          | `365`   | DynamoDB TTL on stored enquiries                     |
| `RateLimitMax`           | `5`     | Submissions per client IP per window                 |
| `RateLimitWindowSeconds` | `3600`  | Rate-limit window length                             |
| `LogRetentionDays`       | `30`    | CloudWatch Logs retention                            |

### CI/CD

`ci.yml` runs on every push and pull request: the link checker, the handler
tests, and `sam validate --lint`. No AWS credentials are needed.

`deploy-backend.yml` deploys the stack on pushes to `main` that touch
`infrastructure/`, or on manual dispatch. It authenticates with GitHub OIDC
rather than long-lived keys, and needs:

- `secrets.AWS_DEPLOY_ROLE_ARN` — an IAM role trusting GitHub's OIDC provider
- `vars.AWS_REGION`, `vars.SENDER_EMAIL`, `vars.RECIPIENT_EMAIL`,
  `vars.ALLOWED_ORIGINS`

## Hosting notes

`amplify.yml` copies only the publishable files into `dist/`, so
`infrastructure/`, `scripts/` and `.github/` are never served. It also sets
HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and
`Permissions-Policy` on every response, and a one-year immutable cache on
`/assets/**`.

A Content-Security-Policy is deliberately not set yet: the pages use a few
inline `style` attributes and a small inline script, and `connect-src` needs the
API Gateway domain, which is only known after the first deploy. Add one once the
endpoint is fixed.

## Handling of contact submissions

The handler validates and length-caps every field, strips control characters,
and strips CR/LF from anything that reaches an email header. Submissions that
fill the hidden honeypot field get a `200` and are discarded. A per-IP fixed
window (5 per hour by default) is enforced with a conditional DynamoDB update,
behind API Gateway's own throttle.

Accepted enquiries are written to DynamoDB — encrypted at rest, point-in-time
recovery on, TTL-expired after `RetentionDays` — and then emailed to the office
with the enquirer's address as `Reply-To`. If the email fails the enquiry is
still recorded and the caller still gets a success, since the message is not
lost.

The form is not a secure channel for confidential material, and the contact page
says so.
