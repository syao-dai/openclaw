---
summary: "Build notes for the OpenClaw Docker image: browser and fonts, vendored Plotly, Python 3.13, and version pinning"
read_when:
  - You are building the gateway Docker image with the browser, fonts, or Plotly bundle
  - You are bumping the pinned Python or Plotly version in the Dockerfile
  - A container vulnerability scan reports Python, pip, or wheel findings
title: "Docker image build"
---

This page covers build-time details of the gateway image defined in the repository `Dockerfile`. For running the gateway in Docker, see [Docker](/install/docker).

## Build command

```bash
# Full build used for report export (screenshots and PPTX): Chromium, CJK fonts, vendored Plotly
docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 -t openclaw:local .
```

`OPENCLAW_INSTALL_BROWSER` is a build arg, not a runtime environment variable. Unless it is non-empty at `docker build` time, Chromium, Xvfb, `fonts-noto-cjk`, and the vendored Plotly file are not installed, and setting it on `docker run` has no effect.

| Build path                | How to pass it                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `docker build`            | `--build-arg OPENCLAW_INSTALL_BROWSER=1`                                                                     |
| `docker compose build`    | Set `build.args.OPENCLAW_INSTALL_BROWSER: "1"` in the compose file. The default `build: .` does not pass it. |
| `scripts/docker/setup.sh` | `export OPENCLAW_INSTALL_BROWSER=1` before running it; the script forwards the variable as a build arg.      |

## Verify a built image

| Check                                                 | Expected                              |
| ----------------------------------------------------- | ------------------------------------- |
| `ls /home/node/.cache/ms-playwright`                  | A `chromium-*` directory              |
| `fc-list :lang=zh`                                    | CJK fonts listed                      |
| `sha256sum /opt/report-export/vendor/plotly-*.min.js` | Matches `PLOTLY_SHA256`               |
| `python3 --version`                                   | 3.13.x                                |
| `pip --version` and `pip show wheel`                  | Current pip and wheel 0.46.2 or newer |

## Pinned versions

| Build arg        | Purpose                                        | Update together with |
| ---------------- | ---------------------------------------------- | -------------------- |
| `PYTHON_VERSION` | Python 3.13 compiled from source               | `PYTHON_SHA256`      |
| `PLOTLY_VERSION` | Plotly bundle used for offline chart rendering | `PLOTLY_SHA256`      |

Each hash is the `sha256sum` of the downloaded file, and the build fails on a mismatch. Python 3.13.4 or newer is required for the CVE-2025-4517 tarfile fix.

The Plotly URL inside generated report HTML must match `PLOTLY_VERSION`. The exporter intercepts only that exact URL and serves the vendored file.

## Python in the image

Two Python installs exist:

- The runtime stage installs Debian `python3` with apt, which is the upstream install for workspace scripts. `src/dockerfile.test.ts` asserts it, so do not remove it without updating that test.
- The Python 3.13 build later repoints `python3` and `pip3` at itself with `update-alternatives`, so scripts run on 3.13. The Debian interpreter stays on disk but is not on the default path.

Python 3.13 is compiled with `--enable-optimizations`. The first build takes several minutes; later builds reuse the Docker layer cache.

## Vulnerability scan notes

| Finding                        | Status                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| CVE-2025-4517 (tarfile)        | Fixed by the pinned Python version                                                                                             |
| CVE-2026-24049 (wheel)         | Fixed by upgrading wheel to 0.46.2 or newer during the build                                                                   |
| CVE-2018-20225 (pip)           | No upstream fix. It only affects `--extra-index-url`; use `--index-url`, or uv with an explicit index, for private packages.   |
| Findings on Debian Python 3.11 | Not on the default execution path. Treat as an accepted exception, or remove the apt `python3` and update the Dockerfile test. |
