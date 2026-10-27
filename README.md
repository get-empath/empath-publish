# Empath Team Builds Publish

**Share every new build of your app with your whole team, automatically.**

Each time your team builds the app, this step adds the new build to your team's build list. Then anyone with Empath (product, design, leadership, support) can open **Devices → Team Builds** and install it in one click. No more sending files around, and no more waiting on an engineer to set it up for them.

## What you should know

- **Your builds stay with you.** Builds go from your build system to your own storage, and from there to your team's Macs. They never pass through Empath, and Empath never sees them.
- **It's small and easy to check.** It's a single file with no add-ons and no tracking, and it needs no Empath account. Anyone on your team can read it in a few minutes.
- **Nothing gets lost.** If the step can't read your current build list, it stops instead of starting a new one, so your build history is always safe.
- **It's optional.** Empath only reads your build list. If you'd rather write it with your own scripts, that works too. The format is in Empath's setup guide.
- **It's free and open source** under the [MIT license](LICENSE).

## Setting it up

It takes three steps, and only an engineer is needed for the first two.

1. **Choose where builds will live.** Any storage your company already uses and that people reach with an `https://` address works: an internal web server, a CDN, Artifactory, or a cloud storage bucket.
2. **Add this step to your build.** Copy the example below into your GitHub workflow.
3. **Share the build list's address.** Everyone pastes it into **Devices → Team Builds → Set Up Team Builds…** in Empath.

```yaml
name: Share with Empath
on:
  push:
    branches: [main]

# One build at a time, so two builds never overwrite each other's list
concurrency: empath-builds

jobs:
  ios:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          xcodebuild -scheme Shop -sdk iphonesimulator \
            -configuration Release -derivedDataPath build

      - uses: get-empath/empath-publish@v1
        with:
          from: https://builds.acme.com/shop/empath-builds.json
          token: ${{ secrets.EMPATH_BUILDS_READ_TOKEN }}
          file: build/Build/Products/Release-iphonesimulator/Shop.app
          platform: ios
          version: 4.3.0
          build: ${{ github.run_number }}
          channel: beta
          app-name: Acme Shop
          app-id: com.acme.shop

      # Your usual upload step. Copy the folder in; don't delete what's already there.
      - run: aws s3 cp empath-builds s3://acme-builds/shop --recursive
```

**Android:** use `runs-on: ubuntu-latest`, `platform: android`, and point `file:` at your `.apk`.

**Moving a build to production:** when a beta build is ready, run the same step with `command: promote` and its build number, then upload again. The build itself is already in your storage, so only the list changes.

**Not using GitHub?** The same tool runs on any build system, as shown in the command line section below.

---

## Details for engineers

### How it works

The tool doesn't upload anything. It:

1. Reads your current build list from `from` (an https address or a file). A 404 starts a new list. Any other failure stops the run.
2. Zips the `.app` if needed, using `ditto` on macOS to keep symlinks and permissions intact, and computes its SHA-256.
3. Writes a folder for your upload step:

```
empath-builds/
  empath-builds.json
  builds/<platform>/<version>-<build>-<sha8>.app.zip | .apk
```

New builds go at the top of their channel. Each channel keeps the newest `keep` builds, 20 by default. Publishing the same file twice doesn't list it twice. Files of builds that drop off the list stay in your storage until you remove them.

### Command line

Needs Node 18 or later.

```sh
EMPATH_BUILDS_TOKEN=… node empath-publish.js publish \
  --out empath-builds \
  --from https://builds.acme.com/shop/empath-builds.json \
  --file Shop.app --platform ios --version 4.3.0 --build 912 --channel beta \
  [--app-name "Acme Shop" --app-id com.acme.shop] [--notes "…"] [--commit "$SHA"] [--keep 20]

node empath-publish.js promote --out empath-builds \
  --from https://builds.acme.com/shop/empath-builds.json \
  --build 912 --from-channel beta --to-channel production
```

### Options

| Option | What it does |
|---|---|
| `command` | `publish` (the default) or `promote` |
| `out` | The folder to write. Default `empath-builds`. |
| `from` | Your published build list. If you leave it out, the tool uses `<out>/empath-builds.json` when that file exists. |
| `token` | A read-only token for `from`. On the command line, set `EMPATH_BUILDS_TOKEN` instead so it stays out of logs. |
| `file` | iOS: the `.app` folder or a zip of it, built with `-sdk iphonesimulator` so it runs in Empath's iOS devices. Android: the `.apk`. |
| `platform` | `ios` or `android` |
| `version`, `build` | Shown to people as `4.3.0 (912)`. `build` is required for `promote`. |
| `channel` | Lowercase letters, numbers and dashes. Default `beta`. |
| `app-name`, `app-id` | Needed for the first build in a list. `app-id` is the bundle ID or package name. |
| `notes`, `commit` | Optional. `commit` defaults to the commit being built. |
| `from-channel`, `to-channel` | For `promote`. Defaults `beta` and `production`. |
| `keep` | Builds kept per channel. Default 20. |

### Security

- **Access.** CI needs write access to your storage. People using Empath need only a read-only token, which Empath stores encrypted in each Mac's Keychain. Rotate the token on your side to cut off access.
- **Checksums.** Empath won't install a file whose SHA-256 doesn't match the build list.
- **Tokens and redirects.** Redirects work, including to signed CDN or storage links. Empath sends the token only to the server in the build list's address, never to a server a redirect leads to. It accepts only `https://`.
- **Pinning.** For the strictest setups, pin the action to a commit SHA instead of `@v1`.
- **Untrusted inputs.** Inputs reach the script through environment variables, never through the script text, so values like release notes can't run as commands.

The full format is in the build list section of Empath's setup guide, under **Devices → Team Builds → Set Up Team Builds…**.
