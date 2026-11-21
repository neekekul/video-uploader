# video-uploader

A project that for now is going to be design for my own local use case. It will automatically upload a Youtube video from an archive on a schedule.

## YouTube setup _REQUIRED_

You only need to do this once. Google renames its console menus from time to time, so the labels below may differ slightly.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. Go to **APIs & Services → Library** and enable **YouTube Data API v3**.
3. Configure the **OAuth consent screen** (Google Auth Platform):
   - Choose user type **External**, then fill in the app name and your email.
   - Under **Audience**, add your Google account as a test user.
   - Then **publish the app** (set it to "In production"). While it stays in "Testing", Google expires the refresh token after 7 days and uploads stop until you sign in again. You don't need Google's verification for personal use. You'll see an "unverified app" warning when you sign in; choose _Advanced → Go to (app name)_.
4. Go to **Credentials → Create credentials → OAuth client ID** and choose application type **Desktop app**. Download the JSON and save it as `credentials/youtube-client-secret.json`.
5. Run `npm run auth:youtube`, open the printed URL, and sign in with the account that owns the channel. The refresh token is saved to `credentials/youtube-token.json`.

Limits to know about:

- **Daily quota:** the default is 10,000 units per day. An upload costs about 1,600, plus 400 per caption track and 50 each for a thumbnail or playlist, so expect around 6 uploads a day. Archives that hit the quota are retried on the next run.
- **Private-only uploads:** until the project passes Google's [API compliance audit](https://support.google.com/youtube/contact/yt_api_form), every video uploaded through the API is locked to private. The result log warns you when this happens.
- **Custom thumbnails:** these need a phone-verified channel.

## Running with Docker _REQUIRED_

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) running. Do the YouTube setup above first; the sign-in step (`npm run auth:youtube`) runs on your machine, not in the container.

```sh
npm run docker:up     # build the image and start it in the background
npm run docker:logs   # follow the logs
npm run docker:down   # stop it
```

The container restarts on its own, including after a reboot once Docker Desktop is running again. It mounts three folders from this project, which you can change in `.env`:

| On your machine                             | In the container    | Purpose                                   |
| ------------------------------------------- | ------------------- | ----------------------------------------- |
| `DROP_DIR` (default `./drop`)               | `/data/drop`        | inbox, done, failed                       |
| `CONFIG_DIR` (default `./config`)           | `/data/config`      | description header and footer (read-only) |
| `CREDENTIALS_DIR` (default `./credentials`) | `/data/credentials` | YouTube client secret and token           |

`SCHEDULE` is evaluated in UTC inside the container. Set `TZ` in `.env` (e.g. `TZ=America/Chicago`) to use your local time.

**Adding archives:** copy each archive somewhere on the same drive first, then move it into `inbox`. A move within the same drive is instant, so the app never sees a half-copied file. If an archive is picked up mid-copy anyway, it fails to extract and is retried on the next run.

## Preparing an archive

Each archive (`.zip`, `.tar.gz` or `.tgz`) holds one video. The files can sit at the top of the archive or inside a single folder. File names are not case-sensitive.

| File                                             | Required | Purpose                                                             |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------- |
| `*.mp4`                                          | yes      | The video. Exactly one per archive.                                 |
| `description.txt`                                | no       | The video description. See below.                                   |
| `metadata.yaml`, `metadata.yml`, `metadata.json` | no       | Title, tags and upload settings. At most one. See below.            |
| `thumbnail.jpg`, `thumbnail.jpeg`, `thumbnail.png` | no     | Custom thumbnail, up to 2 MiB.                                      |
| `<language>.srt`, `<language>.vtt`               | no       | Captions, named after their language: `en.srt`, `pt-BR.vtt`, ...    |

Other files are ignored and listed as warnings in the result log.

### Description and chapters

The final description is built from three parts, separated by blank lines:

1. `config/description-header.txt`, if it exists
2. the archive's `description.txt`
3. `config/description-footer.txt`, if it exists

Copy the `.example` files in `config/` to create your own header and footer. The whole description must stay under 5,000 bytes and must not contain `<` or `>`. YouTube rejects those characters, so `0:00 -> Intro` fails while `0:00 - Intro` works.

**Chapters:** YouTube turns timestamps in the description into chapters, the segments you see in the progress bar. Add the list anywhere in `description.txt`:

```text
A quick walkthrough of building the board from scratch.

0:00 Intro
1:25 Setting up the board
4:10 First test run
12:48 Results
1:02:30 Wrap-up
```

YouTube's rules for chapters:

- The first timestamp must be `0:00`.
- You need at least 3 timestamps, in ascending order.
- Each chapter must be at least 10 seconds long.
- Each timestamp starts its own line, followed by the chapter title.

If the segments don't appear, check the video in YouTube Studio. Some videos aren't eligible for chapters, for example videos made for kids.

### Captions

Add one subtitle file per language, in SubRip (`.srt`) or WebVTT (`.vtt`) format. Name each file after its language tag, and the uploader adds it to the video as a caption track in that language:

```text
my-video.zip
├── video.mp4
├── en.srt        English
├── es.vtt        Spanish
└── pt-BR.srt     Portuguese (Brazil)
```

- **Naming:** use a 2–3 letter language code, optionally followed by a region or script, such as `en`, `de`, `fil`, `en-GB`, `pt-BR` or `zh-Hant`. A file named anything else (`captions.srt`, `english.srt`) sends the archive to `failed/` before anything is uploaded.
- **One file per language:** `en.srt` and `en.vtt` in the same archive is an error.
- **No metadata needed:** the language comes from the file name, and the tracks are published together with the video. Each track gets no name of its own, so viewers just see the language in the captions menu.
- **Quota:** each caption track costs 400 quota units on top of the video's 1,600, so a video with two tracks uses 2,400 of the 10,000 daily units.
- **Failures don't repeat the upload:** captions are added after the video. If YouTube rejects a file, for example because of a broken timestamp, the video stays uploaded and the problem appears under `warnings` in the result log. Add the captions by hand in YouTube Studio in that case.

### Metadata file

Every field is optional, and so is the file itself. Without it, the video is uploaded as **private**, titled after the archive name, in category People & Blogs. YAML and JSON both work. Unknown fields are rejected, so a typo sends the archive to `failed/` instead of being silently ignored.

A full example with every field:

```yaml
title: Building a Board From Scratch
tags: [electronics, tutorial, soldering]
platforms: [youtube]
description:
  includeHeader: true
  includeFooter: false

youtube:
  privacy: private
  publishAt: 2026-12-01T17:00:00-06:00
  categoryId: 28
  madeForKids: false
  containsSyntheticMedia: false
  notifySubscribers: true
  embeddable: true
  publicStatsViewable: true
  license: youtube
  defaultLanguage: en
  defaultAudioLanguage: en
  recordingDate: 2026-11-15
  playlists: [PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx]
  localizations:
    es:
      title: Construyendo una placa desde cero
      description: Un recorrido rápido por la construcción de la placa.
```

#### Shared fields

| Field                       | Default when left out             | Explanation                                                                                              |
| --------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `title`                     | Archive name without its extension | Video title. YouTube allows up to 100 characters and no `<` or `>`.                                      |
| `tags`                      | No tags                           | List of tags. Together they must fit in 500 characters; tags containing spaces count 2 extra for quotes. |
| `platforms`                 | The `PLATFORMS` setting (`youtube`) | Where to upload this archive. Options: `youtube`, `dry-run` (logs what would be uploaded).            |
| `description.includeHeader` | `true`                            | Set to `false` to leave out `description-header.txt` for this video.                                     |
| `description.includeFooter` | `true`                            | Set to `false` to leave out `description-footer.txt` for this video.                                     |

#### `youtube:` fields

Fields marked "YouTube's default" aren't sent at all when left out, so YouTube or your channel's upload defaults decide.

| Field                    | Default when left out                    | Explanation                                                                                                                                                         |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `privacy`                | `private`                                | `public`, `unlisted` or `private`. Until the Google project passes the API audit, YouTube forces every upload to private anyway.                                     |
| `publishAt`              | Not scheduled                            | When the video goes public, as an ISO 8601 date and time with a time zone, e.g. `2026-12-01T17:00:00-06:00` or `2026-12-01T23:00:00Z`. Must be in the future. The video stays private until then, so `privacy` must be `private` or left out. |
| `categoryId`             | `22` (People & Blogs)                    | Numeric category. Common ones: `1` Film & Animation, `10` Music, `17` Sports, `20` Gaming, `22` People & Blogs, `24` Entertainment, `27` Education, `28` Science & Technology. |
| `madeForKids`            | YouTube's default (your channel setting) | Whether the video is made for kids. If your channel has no audience default, YouTube may ask you to set it in Studio.                                               |
| `containsSyntheticMedia` | YouTube's default (`false`)              | Set to `true` to disclose realistic AI-generated or altered content.                                                                                                |
| `notifySubscribers`      | YouTube's default (`true`)               | Set to `false` to skip the subscriber notification and feed entry.                                                                                                  |
| `embeddable`             | YouTube's default (`true`)               | Whether other sites can embed the video.                                                                                                                            |
| `publicStatsViewable`    | YouTube's default (`true`)               | Whether the view count and stats are visible on the watch page.                                                                                                     |
| `license`                | YouTube's default (`youtube`)            | `youtube` (standard YouTube license) or `creativeCommon` (CC BY).                                                                                                   |
| `defaultLanguage`        | Not set                                  | Language of the title and description, e.g. `en`. Required when you use `localizations`.                                                                            |
| `defaultAudioLanguage`   | Not set                                  | Language spoken in the video, e.g. `en`.                                                                                                                            |
| `recordingDate`          | Not set                                  | When the video was recorded: a date (`2026-11-15`, read as midnight UTC) or a date and time with a time zone.                                                       |
| `playlists`              | No playlists                             | Playlist IDs to add the video to, taken from the playlist URL (`list=PL...`). A failure here becomes a warning in the result log, not a failed upload.             |
| `localizations`          | None                                     | Translated titles and descriptions, keyed by language. A missing `title` or `description` falls back to the main one. The header and footer aren't added to translated descriptions. |

Thumbnail, caption and playlist steps run after the video itself is uploaded. If one of them fails, the upload still counts as done and the problem is listed under `warnings` in the result log, so a retry never uploads the video twice.
