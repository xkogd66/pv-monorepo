# PhotoVault User Manual

PhotoVault is a private photo and video gallery. This manual describes what you can do with it and how it behaves. It does not cover how it is built.

**Contents**

1. [Who can do what](#1-who-can-do-what)
2. [Getting in](#2-getting-in)
3. [Browsing albums](#3-browsing-albums)
4. [Viewing photos and videos](#4-viewing-photos-and-videos)
5. [Uploading](#5-uploading)
6. [Importing from OneDrive](#6-importing-from-onedrive)
7. [Monitoring uploads](#7-monitoring-uploads)
8. [Managing albums](#8-managing-albums)
9. [Managing a photo](#9-managing-a-photo)
10. [Sharing](#10-sharing)
11. [Statistics](#11-statistics)
12. [Users and settings](#12-users-and-settings)
13. [Good to know](#13-good-to-know)

---

## 1. Who can do what

| | Visitor (not signed in) | Signed-in user | Admin |
|---|---|---|---|
| Browse public albums and view photos | Yes | Yes | Yes |
| See private albums | No | Yes | Yes |
| View statistics | No | Yes | Yes |
| Upload, import, edit, delete, set covers, manage users | No | No | Yes |

Albums are **private by default**. A private album is invisible to visitors who are not signed in; they cannot tell it exists.

## 2. Getting in

- **Landing page.** Visitors see a landing page with a collage of album covers and a **Browse Galleries** button, which opens the public albums without signing in.
- **Sign in / register.** Both are in the top navigation bar (or the menu on a phone). Sign-in includes a CAPTCHA check. A session lasts 24 hours.
- **Staying signed in.** Refreshing the page keeps you signed in until the session expires.
- **Status dot.** A small dot in the header shows whether the system is healthy; click it for details.

## 3. Browsing albums

The **Albums** page shows a grid of album covers. Under each cover are the album name, the number of photos and the album's month and year, for example `36 photos · May 2026`.

- **Year filter.** Show only albums from one year. Albums with no year appear only under "All years".
- **Sort.** Newest first (default), oldest first, recently modified, least recently modified, name A–Z, name Z–A. Albums with no date always sort last.
- **Refresh.** Reloads the list.
- **Infinite scroll.** More albums load as you scroll. The toolbar stays pinned under the header.
- **Search.** The header search box finds albums by name.
- **Covers.** An album with no photos shows "No photos yet". If a cover image can't load, a neutral placeholder is shown.
- **Phones.** The grid is two columns wide. Admin actions on a card are behind a "⋯" button that opens a bottom sheet; on larger screens they appear when you hover over the cover.

## 4. Viewing photos and videos

Opening an album shows its photos as a grid, with videos in their own section. Photos load in batches as you scroll.

**Lightbox (full-screen photo view)**

- Previous / next with the on-screen arrows or the ← and → keys.
- **Photo info:** date taken, location and camera details.
- **Download** the photo.
- Admin only: **Delete**, **Edit metadata**, **Set as album cover**.

**Videos** open in their own player.

**Album toolbar** (top of an album): refresh, share, upload (admin), and show/hide metadata.

## 5. Uploading

Admin only. Open an album and choose **Upload**.

- **Photos:** JPEG and HEIC. They are converted to a smaller AVIF format and a thumbnail is made for each. Files over 15 MB fail.
- **Videos:** common formats (MP4, MOV, AVI, MKV, WebM, M4V and similar) are stored as they are.
- **Background processing.** After you send the files the upload finishes in the background. You can leave the page and follow progress on the Monitor page.
- **Duplicate check.** If a photo with the same name is already in the album, you are asked whether to replace it. Cancel sends nothing. Videos are not checked.
- **Skipped files.** Files of unsupported types are skipped, and a notice tells you which.

## 6. Importing from OneDrive

Admin only. Use the **cloud-download** icon in the Albums toolbar to copy a OneDrive folder into a new album.

1. **Browse** the OneDrive photo-albums folders. Click a folder to open it; use the breadcrumb to go back.
2. **Pick a folder.** The form fills in from the folder name: `2023 / (02) solna` becomes the album name `solna`, month 2, year 2023. You can edit all fields.
3. **Choose visibility.** Tick or untick **Private album**. It is private by default.
4. **Import this folder.** A confirmation tells you it started; **Go to Monitor** takes you to the progress page.

**What is imported:** JPEG, HEIC and video files from that one folder (not subfolders). Other files are left alone. Nothing on OneDrive is moved or deleted.

**Resuming.** If the album name is already taken, for example because an earlier import was interrupted, the dialog offers **Resume import into the existing album**. It skips files already in the album and imports only what is missing. If everything is already there, it says so. Resuming does not change the album's visibility. A file that was part-way through is downloaded again from the start.

**Good to know**

- The folder list is remembered for up to 24 hours, so a brand-new OneDrive folder may not appear straight away.
- Two folders with the same name in one year (such as two `cph` folders) clash; rename the second in the form.
- If OneDrive sign-in has expired, the dialog shows the error and the connection must be renewed by whoever runs the server.

## 7. Monitoring uploads

The **Monitor** page lists photo uploads, video uploads and OneDrive imports.

- **Filter** by Running, Completed or All. Counters show how many are running and completed. The page refreshes itself; **Refresh** forces it.
- **For each job:** start time, status, and progress: succeeded, failed, files done out of total, and a percentage.
- **Failed files.** If any file failed, a red section lists each failed file with the reason. It is collapsed while the job runs and open once it finishes.
- **Stop upload.** A running job has a **Stop upload** button (after a confirmation). Files not yet started are skipped. The file being processed right now may still finish or may fail. Files already added stay in the album, and the album's photo count may be out of date until the next upload to it. A stopped job shows as TERMINATED.

## 8. Managing albums

Admin only.

- **New album.** Name, optional description, month, year, and private or public (private by default). Names must be unique.
- **Edit album.** Change the name, description, month, year or visibility using the pencil on the album card. Renaming moves the album's files, so it can take a moment.
- **Delete album.** Removes the album and all its photos and videos. This cannot be undone.
- **Cover.** The first photo uploaded becomes the cover. You can choose another from the lightbox with **Set as album cover**.
- **Private or public.** Switching to private hides the album from visitors from then on. Links to photos that visitors already received keep working for up to an hour.

## 9. Managing a photo

Admin only.

- **Delete.** Removes the photo and its thumbnail. If it was the album's cover, the album shows a placeholder until you pick a new one.
- **Edit metadata.** Set the date, time (24-hour, `HH:mm`) and GPS coordinates. If you enter coordinates, the place name is looked up and filled in for you. A date needs a valid time.
- **"Invalid date" or "not found".** The photo had no date or location embedded, which is typical of photos saved from messaging apps. Fix it with Edit metadata. To keep this information in future, export from your phone or Photos app with location included.

## 10. Sharing

**Share** on an album gives you its link, with **Copy**, **WhatsApp**, **Email** and a **QR code**. Anyone opening the link can see the album only if it is public, or if they are signed in.

## 11. Statistics

Available to any signed-in user from **Statistics** in the header: total photos, videos, albums, storage used, and photos per country. Photos with no location are not counted in the country list. Storage includes thumbnails; the photo and video counts do not.

## 12. Users and settings

**User management** (admin): list, create, edit and delete users, and give each the role User or Admin.

**Settings** (admin): reset another user's password.

**Change your own password** from your account menu.

## 13. Good to know

- **Photos are converted.** The original JPEG or HEIC is not kept; the album holds the AVIF version.
- **Large batches are slow on purpose.** Files are processed one at a time.
- **Date and time are shown as recorded.** A time with no timezone is shown exactly as entered, with no shifting.
- **Photo counts** can drift if the same files are uploaded twice. An admin can have them recalculated.
- **Dark mode** follows your device setting.
