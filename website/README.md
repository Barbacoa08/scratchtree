# Scratchtree landing page

Build with `pnpm build:site`. This copies the pinned `@barbajoe/css-lib` stylesheet and the existing synthetic editor overview into `website/dist`. The website has no browser JavaScript or analytics.

`release.json` owns the download asset, release notes, and observed tested environment. Update it when publishing an authorized app release, after verifying the DMG and platform evidence. The development screenshot is labeled separately from the downloadable release.

The favicon and header use unchanged 16px, 32px, and 32px-at-2x PNG representations from the approved native ICNS. The build reads those PNG payloads directly, preserving their size mapping and artwork. See the [branding record](../docs/branding/README.md).

Netlify publishes only `website/dist`. The account-check function and private server settings are outside that directory. Its private `SCRATCHTREE_ALLOWED_EMAILS` list is an eligibility check; Dexie still verifies OTPs and restricts account access. Adding a future account requires updating both that list and Dexie’s registered users. No Dexie management credentials are needed by this endpoint.

The live site is [scratchtree.netlify.app](https://scratchtree.netlify.app). Netlify publishes `website/dist` and the separate account-check function; a desktop app release is a separate authorized operation. Deploy from reviewed source, keep `.netlify` state and private environment files ignored, and verify the public page, asset hashes, native-origin preflight, and known/unknown eligibility responses. Do not send a real OTP merely to check eligibility.

The allowed-email list stays in Netlify's server environment. Never prefix it as a public/Vite variable or inline it into the static site. The static builder does not read it. Public endpoint/database locations are not credentials; operator keys and real emails do not belong in Git. Update the desktop configuration, native CSP, and exact service origin whitelist together if those locations change.
