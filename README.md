# Caivan Deficiency Log

Site deficiency tracker for Caivan Communities land development (Ottawa): CB, GLB, CMB, landscaping and fencing items across projects, contractor punch lists with photos, weekly tracker and Bluebeam imports, and a Monday report.

- Static site, no build step: `index.html`, `app.js`, `logic.js`, libraries in `lib/`.
- Data: Supabase (database, email-code sign-in, private photo storage). Connection in `config.js`. The anon key is public by design; row-level security in the database decides who can see or change anything.
- Database setup: `supabase-setup.sql` (safe to run more than once).
- Live at https://cherifamine085-netizen.github.io/Amin-deficiency-log/ (GitHub Pages, `main` branch).
