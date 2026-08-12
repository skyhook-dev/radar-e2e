# radar Homebrew formula — investigation result

**Bottom line: the described defect does not exist on the current `skyhook-io/homebrew-tap` repo. `Formula/radar.rb` is up to date (v1.9.2, matching the latest release) and is being kept current automatically, on every release, by a workflow that already exists. No workflow change is being shipped as part of this task — see "Why no patch" below.**

This contradicts the brief this task started from, so before anything else: here is the evidence.

## What the brief said vs. what's actually there

The brief's claim was: `release-desktop.yml` regenerates and commits the **cask** on every release, but **nothing** updates the **formula** — so `brew install skyhook-io/tap/radar` serves a CLI stuck at v1.3.2 while the latest release is v1.9.2.

Checked directly against GitHub (not a local clone — see next section) via `gh api repos/skyhook-io/homebrew-tap/contents/Formula/radar.rb` and `gh api repos/skyhook-io/homebrew-tap/commits?path=Formula/radar.rb`:

```
Formula/radar.rb on skyhook-io/homebrew-tap (main), right now:
  version "1.9.2"

Last commit touching that file:
  2026-08-10T00:03:06Z  "Brew formula update for radar version v1.9.2"  (author: goreleaserbot)

v1.9.2 release published: 2026-08-10T00:03:05Z
```

The formula commit landed one second after the release was published. It is not stale — it is being updated automatically, same day, every release.

## Why the investigation concluded otherwise

Two things combined to produce a false read:

**1. The local tap clone at `/Users/eyald/skyhook-public/homebrew-tap` is 106 commits / ~4.5 months behind `origin/main`.**

```
local HEAD:      be74526  2026-03-31  "Update radar-desktop cask to v1.3.2"
origin/main HEAD: f0652fa  2026-08-10  "Update radar-desktop cask to v1.9.2"
git rev-list --count HEAD..origin/main  →  106
```

Reading `Formula/radar.rb` out of that working tree (`cat Formula/radar.rb`, or `git log -- Formula/radar.rb` without first fetching) shows exactly the symptom described: version 1.3.2, last touched by "Brew formula update for radar version v1.3.2". That commit is real — it's just not the most recent one. `git fetch` (read-only, no working-tree change) pulls in the other 106 commits and the picture changes completely: the formula has been updated to v1.9.2, v1.9.1, v1.9.0, v1.8.7, ... continuously, every single release, right up to the present.

**2. `release-desktop.yml` genuinely does not touch the formula — but it was never supposed to.** That workflow is scoped to the desktop app (cask + Scoop manifest for `radar-desktop`). The formula for the **CLI** (`radar` / `kubectl-radar`) is published by a separate, older pipeline:

- `.github/workflows/release.yml` — triggers on the same `v*.*.*` tag push
- runs `goreleaser/goreleaser-action@v7` with `args: release --clean`
- `.goreleaser.yaml` has a `brews:` stanza:
  ```yaml
  brews:
    - name: radar
      repository:
        owner: skyhook-io
        name: homebrew-tap
        token: "{{ .Env.HOMEBREW_TAP_TOKEN }}"
      directory: Formula
      install: |
        bin.install "kubectl-radar"
        bin.install_symlink "kubectl-radar" => "radar"
      test: |
        system "#{bin}/kubectl-radar", "--version"
  ```
  GoReleaser's built-in Homebrew publisher generates `Formula/radar.rb` from this stanza, covering all four archives it built (`goos: [linux, darwin]` × `goarch: [amd64, arm64]`, per the `builds:` section), and pushes straight to `skyhook-io/homebrew-tap` using `HOMEBREW_TAP_TOKEN`. That's the `goreleaserbot` author on every "Brew formula update for radar version vX.Y.Z" commit, going back to the very first tap commits (v0.9.0-rc.4).

So: nothing stopped. This pipeline has been running, unbroken, since the project's earliest releases, and it is still the one publishing the formula today. `release-desktop.yml` was added later to handle the *desktop app*, a different artifact with its own cask/Scoop targets — it was never meant to own the CLI formula, and its absence of formula logic isn't a regression.

## Independent proof the current formula is correct (not just "recently touched")

Per the task's request to verify without cutting a release, I wrote `generate-formula.sh` — a standalone script that, given a tag, downloads the real published `radar_<tag>_<os>_<arch>.tar.gz` assets for all four platform/arch combos via `gh release download`, computes SHA256 itself (not trusting GoReleaser's own `checksums.txt`), and renders a formula in the same shape GoReleaser's `brews:` stanza produces.

Ran it against v1.9.2:

```
./generate-formula.sh v1.9.2 > radar.rb.generated
```

Independently-downloaded-and-hashed SHA256s:

| file | sha256 |
|---|---|
| radar_v1.9.2_darwin_amd64.tar.gz | 54fc12fc53d384973fa69bea79e1a0a8ab105aca2bc8e466775df00871419868 |
| radar_v1.9.2_darwin_arm64.tar.gz | 67b1aca0831acf34d96bd70553f1dcdb972d453555b3f87f64f211f4c111c56f |
| radar_v1.9.2_linux_amd64.tar.gz | 4e8c06572aea132b990a5659782c56e624d8dbe5bc809dbbd77566fe2a47f34c |
| radar_v1.9.2_linux_arm64.tar.gz | 17a878c29024d3e8699fb2ac98911c04c490520db409dbf9905453542ea11942 |

These match the release's own `checksums.txt` (also downloaded and diffed) **and** the `sha256` lines already committed in the live `Formula/radar.rb` on `skyhook-io/homebrew-tap`.

`diff radar.rb.generated <(gh api .../Formula/radar.rb | base64 -d)` → **empty**. The script's output is byte-for-byte identical to what's actually published right now. That's about as strong a confirmation as is possible short of literally re-running the release pipeline: independently-sourced hashes of independently-downloaded files produce the exact formula that's live.

For reference, `radar.rb.generated` (v1.9.2, correct/current) diffed against the stale v1.3.2 copy sitting in the outdated local clone changes only `version`, the four `url` lines, and the four `sha256` lines — the `on_macos`/`on_linux` structure, the `Hardware::CPU` guards, the `bin.install` / `bin.install_symlink "kubectl-radar" => "radar"` install logic, and the `test do ... end` block are untouched. That's expected: it's the same GoReleaser template, just re-rendered for a newer tag — further evidence the generation logic (and by extension the live pipeline) is stable and correct.

## Why no `formula-update.patch` is included

The task asked for a workflow change to `release-desktop.yml` that regenerates and commits `Formula/radar.rb` on release, in the style of the existing cask step. Given the finding above, adding that would not fix anything — the formula is not broken — and it would introduce a real bug that doesn't exist today:

- Both `release.yml` and `release-desktop.yml` trigger on the exact same `push: tags: v*.*.*` event.
- `release.yml`'s `release` job runs GoReleaser (including the `brews:` push to `homebrew-tap`) early — it's a single fast job with no notarization wait.
- `release-desktop.yml`'s `publish` job needs macOS build + Apple notarization (which can take minutes) before it gets to the "Update Homebrew cask" step, and it has an explicit 15-minute retry loop waiting for the GitHub Release to even exist.
- If `release-desktop.yml` also pushed to `Formula/radar.rb` in the same repo, it would race a second, independent `git clone` + `git push origin main` against GoReleaser's own push to the identical file, minutes apart, on every single release. That's a non-fast-forward push failure waiting to happen (or, worse, a successful but redundant/conflicting commit) — a new, self-inflicted flakiness in a pipeline that currently has none.

Shipping a fix for a non-bug that adds a duplicate-writer race felt like the wrong call to make unilaterally. Flagging it here instead: if there's a *different* problem being observed in practice (e.g. `brew install skyhook-io/tap/radar` giving an old version for some users), the next step should be to reproduce that against the real tap (`brew update && brew info skyhook-io/tap/radar`) rather than against a stale local clone, since the automation itself checks out.

## Files in this folder

- `NOTES.md` — this file
- `generate-formula.sh` — standalone, runnable formula generator/verifier (downloads real release assets, hashes them itself, renders the formula). Usage: `./generate-formula.sh v1.9.2 > out.rb`
- `radar.rb.generated` — output of the script for v1.9.2, proven byte-identical to the live tap formula
- No `formula-update.patch` — see "Why no `formula-update.patch` is included" above

## How to verify any of this yourself

```bash
# Confirm the live formula version/date directly from GitHub (bypasses any local clone staleness):
gh api repos/skyhook-io/homebrew-tap/contents/Formula/radar.rb --jq '.content' | base64 -d | grep version
gh api 'repos/skyhook-io/homebrew-tap/commits?path=Formula/radar.rb&per_page=1' --jq '.[0].commit.message, .[0].commit.author.date'

# Confirm the local tap clone is what's stale, not the remote:
cd /Users/eyald/skyhook-public/homebrew-tap && git fetch && git log --oneline HEAD..origin/main | wc -l

# Re-run the independent generator/verifier for any tag:
cd /Users/eyald/wt/radar-hub-e2e/dist-e2e/formula-fix && ./generate-formula.sh v1.9.2 | diff - <(gh api repos/skyhook-io/homebrew-tap/contents/Formula/radar.rb --jq '.content' | base64 -d)
```

After the *next* release (say v1.9.3), the same check should show the tap formula updated within seconds of the release publishing, authored by `goreleaserbot`, with message `Brew formula update for radar version v1.9.3` — same as it has for every release before it.
