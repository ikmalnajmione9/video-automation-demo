// index.js — Final (batch commit, conflict-safe, preserves editorial fields)
// ---------------------------------------------------------------
// REQUIREMENTS
//   npm i googleapis axios
// ENV
//   Local: set GITHUB_PAT (if you want to run locally), and place demo-service-key.json beside this file
//   GitHub Actions: we use GITHUB_TOKEN injected by Actions, and write the key from repo secret
// ---------------------------------------------------------------

const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// ====== CONFIG: fill these once ======
const SOURCE_DRIVE_FOLDER_ID = process.env.SOURCE_DRIVE_FOLDER_ID || 'YOUR_SOURCE_FOLDER_ID';

const GITHUB_REPO_OWNER = process.env.GITHUB_REPO_OWNER || 'ikmalnajmione9';
const GITHUB_REPO_NAME  = process.env.GITHUB_REPO_NAME  || 'video-automation-demo';
const GITHUB_JSON_PATH  = process.env.GITHUB_JSON_PATH  || 'videos.json';

// Prefer Actions token; fall back to local PAT for local testing
const GITHUB_PAT = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;

// Service account key JSON path (Actions writes this file to the repo root)
const SERVICE_KEY_PATH = path.join(__dirname, 'demo-service-key.json');

// ---------------------------------------------------------------
// Google Drive (service account; read-only)
const auth = new google.auth.GoogleAuth({
  keyFile: SERVICE_KEY_PATH,
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});
const drive = google.drive({ version: 'v3', auth });

// GitHub helpers
const ghHeaders = {
  Authorization: `Bearer ${GITHUB_PAT}`,
  Accept: 'application/vnd.github.v3+json',
  'User-Agent': 'video-automation-script'
};

async function ghGetJson(owner, repo, filePath) {
  try {
    const { data } = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
      { headers: ghHeaders }
    );
    const sha = data.sha;
    let decoded = Buffer.from(data.content || '', 'base64').toString('utf8');
    if (decoded.charCodeAt(0) === 0xfeff) decoded = decoded.slice(1);
    let json = [];
    try { json = JSON.parse(decoded); } catch { json = []; }
    if (!Array.isArray(json)) json = [];
    return { json, sha };
  } catch (e) {
    if (e.response?.status === 404) return { json: [], sha: undefined }; // first run
    throw e;
  }
}

async function ghPutJson(owner, repo, filePath, json, sha, message) {
  const content = Buffer.from(JSON.stringify(json, null, 2)).toString('base64');
  await axios.put(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    { message, content, sha },
    { headers: ghHeaders }
  );
}

// ---------------------------------------------------------------
// Utilities
function niceTitle(name = '') {
  return name
    .replace(/\.[^.]+$/, '')      // remove extension
    .replace(/[-_]+/g, ' ')       // dashes/underscores -> spaces
    .replace(/\s+/g, ' ')         // collapse spaces
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase()); // Title Case
}

function isLikelyVideo(file) {
  // Accept if Drive marks as video/* or filename looks like typical video
  if ((file.mimeType || '').startsWith('video/')) return true;
  const n = (file.name || '').toLowerCase();
  return /\.(mp4|mov|mkv|webm|avi|m4v|wmv)$/i.test(n);
}

// ---------------------------------------------------------------
// Drive accessors
async function listDriveVideos() {
  // Use a broad query (handles odd mimeTypes) and filter in JS for video-ish files
  const q = [
    `'${SOURCE_DRIVE_FOLDER_ID}' in parents`,
    `trashed = false`
  ].join(' and ');

  const { data } = await drive.files.list({
    q,
    fields: 'files(id, name, mimeType, modifiedTime)',
    pageSize: 1000,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const files = (data.files || []).filter(isLikelyVideo);
  return files;
}

async function getFileLinks(fileId, fallbackName) {
  const { data: meta } = await drive.files.get({
    fileId,
    fields: 'id, name, webViewLink, webContentLink, thumbnailLink',
    supportsAllDrives: true,
  });

  const previewUrl = `https://drive.google.com/file/d/${meta.id}/preview`;

  return {
    id: meta.id,
    name: meta.name || fallbackName,
    previewUrl,
    webViewLink: meta.webViewLink,
    webContentLink: meta.webContentLink,
    thumbnail: meta.thumbnailLink,
  };
}

// ---------------------------------------------------------------
// MAIN: batch merge all changes, commit once
async function processVideos() {
  if (!GITHUB_PAT) {
    throw new Error('Missing GitHub token (GITHUB_TOKEN in Actions or GITHUB_PAT locally).');
  }
  if (!SOURCE_DRIVE_FOLDER_ID || SOURCE_DRIVE_FOLDER_ID === 'YOUR_SOURCE_FOLDER_ID') {
    throw new Error('Set SOURCE_DRIVE_FOLDER_ID (env var or hardcode).');
  }

  // 1) Read current videos.json once
  const { json: currentJson, sha: baseSha } = await ghGetJson(
    GITHUB_REPO_OWNER, GITHUB_REPO_NAME, GITHUB_JSON_PATH
  );

  // Build a map for fast merge
  const map = new Map(currentJson.map(v => [v.driveFileId, v]));
  const beforeLen = currentJson.length;

  // 2) List Drive files; merge in memory
  const driveFiles = await listDriveVideos();
  const now = new Date().toISOString();

  // For small change logging (console only)
  const added = [];
  const updated = [];

  for (const file of driveFiles) {
    const links = await getFileLinks(file.id, file.name);
    const exists = map.get(links.id);

    if (exists) {
      // Preserve editorial fields (title/status); update technical fields
      const merged = {
        ...exists,
        name: links.name,
        url: links.previewUrl,
        driveFileId: links.id,
        driveWebView: links.webViewLink,
        driveDownload: links.webContentLink,
        thumbnail: exists.thumbnail || links.thumbnail,
        source: 'drive',
        updatedAt: now
      };
      map.set(links.id, merged);

      // mark as updated if something actually changed (simple detect)
      if (
        exists.name !== merged.name ||
        exists.url !== merged.url ||
        exists.driveDownload !== merged.driveDownload
      ) updated.push(links.name);
    } else {
      // New item → default editorial fields
      const item = {
        title: niceTitle(links.name),
        status: 'new',
        name: links.name,
        url: links.previewUrl,
        driveFileId: links.id,
        driveWebView: links.webViewLink,
        driveDownload: links.webContentLink,
        thumbnail: links.thumbnail,
        source: 'drive',
        publishedAt: now
      };
      map.set(links.id, item);
      added.push(links.name);
    }
  }

  // 3) Optionally: prune items that no longer exist in the folder (OFF by default)
  // If you want to remove videos that were removed from the Drive folder, uncomment below:
  // const driveIds = new Set(driveFiles.map(f => f.id));
  // for (const id of Array.from(map.keys())) {
  //   if (!driveIds.has(id)) map.delete(id);
  // }

  // 4) Build final array & sort newest first
  const updatedArray = Array.from(map.values())
    .sort((a, b) => new Date(b.publishedAt || b.updatedAt || 0) - new Date(a.publishedAt || a.updatedAt || 0));

  // 5) Only PUT if the content actually changed
  const before = JSON.stringify(currentJson);
  const after  = JSON.stringify(updatedArray);

  if (before !== after) {
    await ghPutJson(
      GITHUB_REPO_OWNER,
      GITHUB_REPO_NAME,
      GITHUB_JSON_PATH,
      updatedArray,
      baseSha,
      'Publish videos (batch)'
    );

    // Console log summary for Actions logs
    const delta = updatedArray.length - beforeLen;
    console.log('Committed batch update to videos.json');
    console.log('Added:', added);
    console.log('Updated:', updated);
    console.log('Count before:', beforeLen, 'after:', updatedArray.length, 'delta:', delta);
  } else {
    console.log('No changes detected; skipped commit.');
  }
}

// Run when invoked directly
processVideos()
  .then(() => console.log('Batch sync complete'))
  .catch(err => {
    console.error(err?.response?.data || err);
    process.exit(1);
  });

// (Optional) export for Cloud Functions, if you ever deploy there:
// exports.demoProcessVideos = async (req, res) => {
//   try { await processVideos(); res.status(200).send('OK'); }
//   catch (e) { console.error(e?.response?.data || e); res.status(500).send('ERR'); }
// };
