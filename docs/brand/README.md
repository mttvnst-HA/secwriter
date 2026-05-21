# SecWriter Brand Kit

Logo variant A (bracket glyph + wordmark), rendered into every asset SecWriter needs as a deployed web app and a public GitHub project.

## Color tokens

a. Ink (dark)   #0f172a
b. Accent (cyan)  #0ea5e9 (and #38bdf8 on dark backgrounds)
c. Paper (light)  #f8fafc
d. Cursor 2 (orange, collab accent only)  #f97316
e. Cursor 3 (purple, collab accent only)  #a855f7

## Files

### Vector masters (edit these)

a. icon-mark.svg - the square blue tile with the </> glyph; master for every favicon and app icon
b. favicon.svg - same tile, wired with prefers-color-scheme; for the modern <link rel="icon" type="image/svg+xml"> slot
c. logo-full-light.svg - full lockup, light theme; for the README header and light-mode site headers
d. logo-full-dark.svg - full lockup, dark theme; for dark-mode site headers
e. og-image.svg - Open Graph 1200x630 card for Slack/LinkedIn/Twitter/Teams link previews
f. github-social-preview.svg - GitHub repo social preview 1280x640 (Settings > Social preview)

### Raster (auto-generated from the SVGs by _build.py)

a. favicon.ico - multi-resolution 16/32/48; legacy fallback
b. icon-16.png, icon-32.png - referenced in <link rel="icon" sizes="..."> tags
c. icon-48.png, icon-64.png, icon-128.png, icon-256.png - app shortcuts, Windows tiles, miscellaneous
d. icon-180.png - iOS Safari touch icon master
e. icon-192.png, icon-512.png - PWA install icons
f. icon-1024.png - storefront / high-res app icon
g. apple-touch-icon.png - iOS Safari home-screen bookmark (180x180)
h. android-chrome-192x192.png, android-chrome-512x512.png - Android Chrome PWA install icons
i. logo-full-light.png, logo-full-dark.png - 1200x320 PNG lockups; drop into READMEs that do not render SVG
j. og-image.png - 1200x630 social card PNG
k. github-social-preview.png - 1280x640 GitHub social preview PNG

### Site configuration

a. site.webmanifest - PWA manifest; declares name, theme color, install icons
b. head-snippet.html - paste this into the <head> of index.html to wire up every asset
c. _build.py - regenerates every PNG and the ICO from the SVG masters; run with `python _build.py`

## Deployment

1. Copy every file except _build.py and this README to the public root of secwriter (the same level as index.html).
2. Paste head-snippet.html into the <head> of index.html.
3. In the GitHub repo: Settings > Social preview > Edit > upload github-social-preview.png.
4. Verify the OG card at https://www.opengraph.xyz or https://cards-dev.twitter.com/validator after deploying.

## Editing the brand

To change colors, font, or spacing: edit the relevant `.svg` master and re-run `python _build.py`. All PNGs and the ICO regenerate from the SVGs - no separate raster art to maintain.
