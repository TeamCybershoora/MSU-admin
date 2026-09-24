# MSU Admin Portal

Administration backend for **Maa Shakumbhari University (MSU)**. A standalone Next.js application that manages students, results, notices, syllabus, and colleges.

**Production URL:** https://admin.msu.ac.in
**Public MSU Website:** https://msu.ac.in (separate application in `D:/msu`)

## Architecture

```
                         MSU SYSTEM
                             │
                ┌────────────┴────────────┐
                │                         │
                ▼                         ▼
        https://msu.ac.in        https://admin.msu.ac.in
                │                         │
                ▼                         ▼
          MSU WEBSITE               MSU ADMIN
       Public + Student          Administration
                │                         │
                └────────────┬────────────┘
                             │
                             ▼
                          MongoDB
```

Both applications share the **same MongoDB database** but are deployed as independent Next.js apps with separate auth systems.

## Tech Stack

| Layer | Technology |
| --- | --- |
| **Framework** | Next.js 16 (App Router, Turbopack) |
| **Frontend** | React 19, TypeScript, CSS Modules |
| **Backend** | Next.js Route Handlers (`app/api/`) |
| **Database** | MongoDB + Mongoose 8 (ODM) |
| **Authentication** | JWT (HS256, 2h expiry) + bcrypt (10 salt rounds) |
| **Icons** | Lucide React |

## Getting Started

### Prerequisites

- **Node.js** 18+ (recommended: 20+)
- **MongoDB** — same instance as the MSU website

### 1. Install dependencies

```bash
npm install
```

### 2. Set up environment variables

Create a `.env.local` file in the project root:

```env
MONGODB_URI=mongodb://localhost:27017/msu
JWT_SECRET=your-secret-key-must-be-at-least-32-characters-long
```

> **Security:** `.env.local` is gitignored. Never commit secrets.

### 3. Start the development server

```bash
npm run dev
```

Open [http://localhost:3000/admin/login](http://localhost:3000/admin/login)

### 4. Create an admin account

```bash
npx tsx scripts/create-admin.ts
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the dev server with Turbopack |
| `npm run build` | Create an optimized production build |
| `npm run start` | Serve the production build |
| `npm run create-admin` | Create a new admin account |

## Project Structure

```
msu-admin/
├── app/
│   ├── admin/                    # Admin pages (client components)
│   │   ├── layout.tsx            # Shared admin shell (sidebar + header)
│   │   ├── page.tsx              # Dashboard with stats
│   │   ├── login/page.tsx        # Admin login
│   │   ├── students/page.tsx     # Student management (search, edit)
│   │   ├── results/page.tsx      # Result management (CRUD)
│   │   ├── notices/page.tsx      # Notice management (CRUD)
│   │   ├── syllabus/page.tsx     # Syllabus management (CRUD)
│   │   └── colleges/page.tsx     # College management + PDF config
│   ├── api/admin/                # Server-side API routes
│   │   ├── login/route.ts        # POST — admin authentication
│   │   ├── dashboard/route.ts    # GET — aggregate statistics
│   │   ├── students/route.ts     # GET + PUT — student management
│   │   ├── results/route.ts      # GET + POST + PUT + DELETE — results
│   │   ├── notices/route.ts      # GET + POST + PUT + DELETE — notices
│   │   ├── syllabus/route.ts     # GET + POST — syllabus management
│   │   ├── colleges/route.ts     # GET + POST + PUT + DELETE — colleges
│   │   └── site-config/route.ts  # GET + PUT — key-value config store
│   ├── layout.tsx                # Root layout
│   ├── page.tsx                  # Landing/redirect
│   └── globals.css               # Global styles & design tokens
├── components/
│   ├── ui/                       # Reusable UI primitives
│   │   ├── card.tsx              # Card, CardHeader, StatCard
│   │   ├── button.tsx            # Button with variants and loading state
│   │   ├── modal.tsx             # Modal and ConfirmDialog
│   │   └── badge.tsx             # Status/category badges
│   ├── empty-state.tsx           # Empty list placeholder
│   └── error-state.tsx           # Error placeholder with retry
├── lib/
│   ├── auth.ts                   # Client-side auth (localStorage, token mgmt)
│   ├── auth-helpers.ts           # Server-side JWT + bcrypt operations
│   ├── admin-auth.ts             # Server-side admin authentication middleware
│   ├── mongodb.ts                # Cached Mongoose connection singleton
│   ├── rate-limit.ts             # In-memory rate limiter
│   ├── validation.ts             # Shared validation + escapeRegex()
│   └── notice-types.ts           # Notice categories, statuses, content types
├── models/
│   ├── Admin.ts                  # Admin accounts (name, email, role, status)
│   ├── Student.ts                # Student accounts (mirrors MSU website)
│   ├── Result.ts                 # Semester exam results with subject marks
│   ├── Notice.ts                 # Notices, circulars, news
│   ├── College.ts                # Affiliated colleges
│   ├── Syllabus.ts               # Programme + semester syllabus
│   └── SiteConfig.ts             # Key-value configuration store
├── scripts/
│   └── create-admin.ts           # CLI script to create admin accounts
├── .env.local                    # Environment variables (gitignored)
├── next.config.ts
├── tsconfig.json
└── package.json
```

## API Endpoints

All admin API routes require a valid JWT in the `Authorization: Bearer <token>` header.

| Endpoint | Methods | Rate Limit | Description |
| --- | --- | --- | --- |
| `/api/admin/login` | POST | 10/15min | Admin authentication |
| `/api/admin/dashboard` | GET | — | Aggregate statistics |
| `/api/admin/students` | GET, PUT | 60/15min | Student search, filter, edit |
| `/api/admin/results` | GET, POST, PUT, DELETE | 60/15min | Full CRUD for results |
| `/api/admin/notices` | GET, POST, PUT, DELETE | 60/15min | Full CRUD for notices |
| `/api/admin/syllabus` | GET, POST | 60/15min | List and upsert syllabus |
| `/api/admin/colleges` | GET, POST, PUT, DELETE | 60/15min | Full CRUD for colleges |
| `/api/admin/site-config` | GET, PUT | 60/15min | Key-value config store |

## Security

- **Authentication:** JWT-based (HS256, 2h expiry). Every admin API route calls `authenticateAdmin()` which verifies the token AND checks the admin is active in the database.
- **Authorization:** Role check (`role !== "student"`) prevents student tokens from accessing admin endpoints.
- **Rate limiting:** In-memory per-IP rate limiting on all endpoints. Login is stricter (10/15min) than data endpoints (60/15min).
- **Password hashing:** bcrypt with 10 salt rounds. Password field has `select: false` in the schema.
- **Account enumeration prevention:** Generic error messages ("Invalid email or password") for failed login attempts.
- **Regex safety:** User search input is escaped with `escapeRegex()` before use in MongoDB `$regex` to prevent ReDoS/injection.
- **Input validation:** Server-side validation on all write operations (field types, required fields, enum values).

## Database

This application shares the same MongoDB database as the MSU website. Models are defined independently to allow separate deployments, but they operate on the same collections.

**Collections used:**
- `admins` — Admin accounts
- `students` — Student accounts (managed by both apps)
- `results` — Examination results
- `notices` — University notices, circulars, news
- `colleges` — Affiliated colleges
- `syllabi` — Programme/semester syllabus records
- `siteconfigs` — Key-value configuration store

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `MONGODB_URI` | Yes | MongoDB connection string |
| `JWT_SECRET` | Yes | JWT signing key (minimum 32 characters) |

> **Never expose `.env.local` values.** The `.env.example` file shows variable names only.

## License

MIT
