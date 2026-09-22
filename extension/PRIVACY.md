# Intrafeur Toolbox — Data collection & permissions

## What data this extension handles

- **Student names and email addresses**, read from the Attendances/Registrations
  table already displayed on `my.epitech.eu` pages you have access to as
  pedagogy staff. The extension does not collect any data beyond what the
  page already shows you.
- **Faction assignments** you create (a label + color per student).

## Where that data goes

- To the backend URL **you configure** in the extension's Options page (a
  small API you self-host — see `backend/`). The extension does not send
  data anywhere else.
- Nothing is sent to the extension author, to any analytics service, or to
  any third party. There is no telemetry.

## What's stored, and where

- **In the browser** (`storage.sync`): only your backend connection settings
  — the API base URL and bearer token. Not the student data itself.
- **On your backend** (SQLite, in the Docker volume): the faction list and
  the student-email → faction assignments. This is the shared, persistent
  store all pedagogy staff read from and write to.

## Permissions used, and why

| Permission | Purpose |
|---|---|
| `storage` | Save your backend URL/token in the Options page. |
| `host_permissions: https://my.epitech.eu/*` | Read the Attendances table and inject the Faction column/sort/filter UI on that site only. |
| `optional_host_permissions: <all_urls>` | The backend URL is self-hosted and chosen by each install at runtime, so it can't be declared at build time. This permission is requested — via a browser permission prompt — only when you enter a backend URL in Options, scoped by the browser to that URL's origin, not actually all sites. |

## Data sale / sharing

None. This extension does not sell, rent, or share collected data with any
third party, and does not use it for advertising or for purposes unrelated
to the tagging/sorting/filtering feature it provides.
