# Classroom Admin — OU & Course Manager

A single-page admin console for browsing Google Workspace Organizational
Units, bulk-enrolling students, and inspecting/managing Google Classroom
courses — including courses whose owning teacher account has since been
suspended or deleted.

Two parts:
- `index.html` — the frontend. Pure HTML/JS (UnoCSS runtime, no build step).
- `Code.gs` — the backend, deployed as a Google Apps Script Web App.

## What changed from the original version

- **Fixed bugs**: the "scan teachers from OU" course-scoping control silently
  limited which classrooms you could see (and could miss courses owned by
  suspended teachers if they weren't returned by the per-OU user scan). It's
  removed — `getCourses` now always lists every course in the domain in one
  pass, which is both simpler and the only reliable way to surface
  owner-deactivated courses.
- **New**: a stats row (Total classrooms / Active / Owner deactivated /
  Distinct teachers) plus an "Only owner-deactivated" filter and a badge on
  each course row, so you can find classrooms made by teachers who've left
  or been suspended.
- **New**: course listing is cached server-side for 5 minutes (`refresh=1`
  to force a rescan) so the domain-wide sweep doesn't hit quota/timeout on
  every click.
- **UI**: modernized visual style (new color system, spacing, focus states),
  same layout and functionality otherwise.
- **Config**: `API_URL` now clearly marked as a placeholder — the page shows
  a clear error instead of a silent network failure if you forget to set it.

## 1. Deploy the backend (Google Apps Script)

1. Go to [script.google.com](https://script.google.com) and create a new
   project (use an account that is a **Google Workspace super admin**, or at
   minimum has admin privileges for both **Admin Console → Users** and
   **Google Classroom**).
2. Delete the default `Code.gs` content and paste in this repo's `Code.gs`.
3. Enable the two Advanced Google Services this script needs:
   - In the editor sidebar, click **Services** (the `+` icon).
   - Add **Admin SDK API** (identifier: `AdminDirectory`).
   - Add **Google Classroom API** (identifier: `Classroom`).
4. Enable the matching APIs in the linked Google Cloud project:
   - In the editor, click the gear icon → **Project Settings** → note the
     **Google Cloud Platform (GCP) Project** number/link (or let Apps
     Script create a default one).
   - Open that project in [Cloud Console](https://console.cloud.google.com/apis/library)
     and enable:
     - **Admin SDK API**
     - **Google Classroom API**
5. Add the OAuth scopes the script needs. Apps Script normally infers scopes
   automatically from the code, but since this script touches sensitive
   admin data, it's worth pinning them explicitly. In the editor, go to
   **Project Settings → Show "appsscript.json" manifest file**, and make sure
   it includes:
   ```json
   {
     "oauthScopes": [
       "https://www.googleapis.com/auth/admin.directory.orgunit.readonly",
       "https://www.googleapis.com/auth/admin.directory.user.readonly",
       "https://www.googleapis.com/auth/classroom.courses",
       "https://www.googleapis.com/auth/classroom.courses.readonly",
       "https://www.googleapis.com/auth/classroom.rosters",
       "https://www.googleapis.com/auth/classroom.profile.emails"
     ]
   }
   ```
6. **Deploy → New deployment**:
   - Type: **Web app**
   - Execute as: **Me** (your admin account) — this is what lets the script
     see every OU, every user, and every course domain-wide, regardless of
     who's using the frontend.
   - Who has access: **Anyone within [your domain]** (recommended) or
     **Anyone**, depending on whether you want it usable outside your org.
   - Click **Deploy**, authorize the requested scopes when prompted (you'll
     see an "unverified app" warning the first time since this is your own
     script — click **Advanced → Go to [project] (unsafe)** to proceed).
   - Copy the **Web app URL** — you'll need it in step 2.

   > If you change the code later, use **Manage deployments → Edit → New
   > version** and redeploy; editing `Code.gs` alone does not update a
   > live Web App URL's behavior until you push a new version.

## 2. Configure and deploy the frontend (GitHub Pages)

1. In `index.html`, find:
   ```js
   const API_URL = "PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE";
   ```
   and replace it with the Web App URL from step 1 (it looks like
   `https://script.google.com/macros/s/AKfycb.../exec`).
2. Push `index.html` to a GitHub repo.
3. In the repo, go to **Settings → Pages**, set **Source** to the branch and
   root folder containing `index.html`, and save. GitHub will publish it at
   `https://<username>.github.io/<repo>/`.
4. Because the Apps Script endpoint doesn't implement CORS preflight
   (`OPTIONS`), the frontend intentionally sends POST bodies as
   `text/plain;charset=utf-8` (a CORS "simple" request) rather than
   `application/json` — don't change that unless you also add `doOptions()`
   handling in `Code.gs`.

## 3. Verify it's working

- Open the deployed page. The **OU & Students** tab should populate the OU
  dropdown within a couple seconds.
- Switch to **Classrooms** — the stats row should populate, and any courses
  owned by suspended/deleted teachers should show an **Owner inactive**
  badge (check the "Only owner-deactivated" box to isolate them).
- If you see a toast saying "Set API_URL…", you skipped step 2.1 above.
- If you see "Server responded with status 401/403", the account used to
  authorize the Apps Script deployment lacks the Workspace admin roles
  described in step 1.

## Notes on permissions

- This tool can add/remove teachers and students on any course, and its
  admin views intentionally include suspended/deleted-owner data — treat
  the deployed URL like any other admin credential. Restrict "Who has
  access" to your domain, and consider putting the Pages URL behind your
  org's SSO/IP allowlist if your hosting supports it.
- Removing the last teacher from a course or removing yourself from a
  course you're the sole owner of can be blocked by the Classroom API; this
  is expected Google-side behavior, not a bug in this tool.