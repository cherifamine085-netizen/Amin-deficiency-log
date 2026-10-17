# Put the Deficiency Log online (about 10 minutes)

Your Supabase project (`tjhourticasazotjueeb`) is already connected in `config.js`. Three steps are left that only you can do.

## 1. Finish the database (1 min)
1. Open supabase.com → your project → **SQL Editor** → **New query**.
2. Open `supabase-setup.sql` in Notepad, copy everything, paste it, click **Run**. You should see "Setup complete".
   - If it says *pg_cron* isn't available: **Database → Extensions** → search `pg_cron` → turn it on → **Run** again.

## 2. Make sign-in emails send a code (2 min)
**Authentication → Emails → Templates → Magic Link** (or "Magic link or OTP"). Set:
- Subject: `Your sign-in code`
- Body:
```
<h2>Your Caivan Deficiency Log code</h2>
<p>Enter this code to sign in: <strong>{{ .Token }}</strong></p>
<p>It expires in 1 hour. If you didn't ask for it, ignore this email.</p>
```
Click **Save**.

## 3. Publish the website (5 min, free)
1. Unzip `caivan-deficiency-online.zip`.
2. Go to **https://app.netlify.com/drop**, sign up (free), and drag the **caivan-deficiency-online** folder onto the page.
3. You get a link like `https://something.netlify.app`. That's your app. (In Netlify you can rename it under *Site configuration → Change site name*.)
4. In Supabase: **Authentication → URL Configuration → Site URL**, paste that link and save.

## 4. Use it
- Open the link → enter **cherifamine085@gmail.com** → type the 6-digit code from your email. You're the admin.
- **Phone**: open the link → Safari Share → **Add to Home Screen** (Android: Chrome menu → **Install app**). It works with no signal on site; changes upload when you're back online.
- **Team**: More → Team → add emails as Editor (field team) or Viewer (supervisor).
- **Monday report** builds itself every Monday at 7 a.m. Ottawa time.

## Good to know
- Free Supabase projects pause after about a week with no use. If that happens, click **Restore** in Supabase.
- Supabase's built-in email only sends a few codes per hour. Fine for a small team.
- To update the app later, drag the new folder onto your site's **Deploys** page in Netlify.
