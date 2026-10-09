# MSU Admin

Admin portal for the MSU system. A separate Next.js (App Router) application
that manages the university's admin-facing data — colleges, students, results,
notices, syllabus, academic structure, enquiries and site configuration —
through its own `app/api/admin/**` route handlers.

> This repository is the **admin** project only. The public university website
> is a separate project with its own repository and is not built from here.

## Tech stack

- Next.js 16 (App Router) + React 19 + TypeScript
- MongoDB via Mongoose
- Auth: JWT (`jsonwebtoken`). Super Admin passwords are bcrypt-hashed; normal
  admin passwords are stored with AES-256-GCM so an authorized Super Admin can
  recover them (see `lib/password.ts`)
- Email: Nodemailer over SMTP for enquiry acknowledgements and replies
- Icons: `lucide-react`

## Getting started

```bash
npm install
npm run dev
```

Configuration is read from environment variables (for local development, a
`.env.local` file at the project root). Variable **names** include
`MONGODB_URI`, `JWT_SECRET`, `ADMIN_PASSWORD_ENCRYPTION_KEY`, the `SMTP_*` /
`EMAIL_*` delivery settings, and the admin bootstrap values used by the
`create-admin` / `create-super-admin` scripts. Never commit or print their
**values**; see the source modules and `.env.example` for the full list.

## Layout

- `app/` — admin UI pages and `app/api/admin/**` route handlers
- `components/` — shared UI and feature components
- `lib/` — auth, validation, email, PDF storage and other helpers
- `models/` — Mongoose models
- `scripts/` — operational and diagnostic scripts

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js dev, build and production server |
| `npm run lint` | ESLint |
| `npm run create-admin` / `create-super-admin` | Create admin accounts |
| `npm run seed:bca` / `seed:bca:dry-run` | Seed / dry-run the BCA syllabus data |
| `npm run diag:password` | Password diagnostics |
| `npm run test:*` | Focused checks (password, admin auth, login API, enquiry validation/categories/inquiry type/ack templates, programme structure, public syllabus, email config) |

Many scripts are operational and write to MongoDB. Run them only against the
intended database and with intent.
