// index.js — Drive (read-only) → GitHub JSON (no copying, no billing)
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// ======= REQUIRED: fill these =======
const SOURCE_DRIVE_FOLDER_ID = '1JTrOol-Zskge6zRC-1dbJ86bplocgFhW'; // your source folder (set to "Anyone with the link: Viewer")

const GITHUB_REPO_OWNER = 'ikmalnajmione9';
const GITHUB_REPO_NAME  = 'video-automation-demo';
const GITHUB_JSON_PATH  = 'videos.json';

// Replace the hardcoded PAT with the GitHub Actions token:
const GITHUB_PAT = process.env.GITHUB_TOKEN;

const SERVICE_KEY_PATH  = path.join(__dirname, 'demo-service-key.json');
// ====================================

// Google Auth with Service Account (read-only to Drive)
const auth = new google.auth.GoogleAuth({
  keyFile: SERVICE_KEY_PATH,
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});
const drive = google.drive({ version: 'v3', auth });

const PROCESSED_LOG = path.join(__dirname, 'processed.txt');

async function getProcessed() {
  try {
    return new Set((await fs.readFile(PROCESSED_LOG, 'utf8')).split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

// List new videos in the source folder
async function listNewVideos() {
  const query = [
    `'${SOURCE_DRIVE_FOLDER_ID}' in parents`,
    `mimeType contains 'video/'`,
    `trashed = false`,
  ].join(' and ');

  const { data } = await drive.files.list({
    q: query,
    fields: 'files(id, name, mimeType, modifiedTime)',
    pageSize: 1000,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return data.files || [];
}

// Build preview + helpful links for an existing Drive file
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
    webContentLink: meta.webContentLink, // direct download link
    thumbnail: meta.thumbnailLink,
  };
}

async function updateGithubJson(entry) {
  function niceTitle(name = "") {
    return name
      .replace(/\.[^.]+$/, "")       // remove extension
      .replace(/[-_]+/g, " ")        // dashes/underscores -> spaces
      .replace(/\s+/g, " ")          // collapse spaces
      .trim()
      .replace(/\b\w/g, c => c.toUpperCase()); // Title Case
  }

  const ghHeaders = {
    Authorization: `Bearer ${GITHUB_PAT}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'video-automation-script'
  };

  let sha;
  let currentJson = [];

  // 1) Load current videos.json (if exists)
  try {
    const { data } = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${GITHUB_JSON_PATH}`,
      { headers: ghHeaders }
    );
    sha = data.sha;

    let decoded = Buffer.from(data.content || '', 'base64').toString('utf8');
    if (decoded.charCodeAt(0) === 0xfeff) decoded = decoded.slice(1);
    try {
      const parsed = JSON.parse(decoded);
      if (Array.isArray(parsed)) currentJson = parsed;
    } catch {
      // If broken, start fresh but don’t crash the run
      currentJson = [];
    }
  } catch (e) {
    if (e.response?.status !== 404) throw e; // 404 means new file; fine
  }

  // 2) Merge logic (preserve editorial fields)
  const now = new Date().toISOString();
  const idx = currentJson.findIndex(v => v.driveFileId === entry.id);

  if (idx >= 0) {
    // Keep existing editorial fields
    const prev = currentJson[idx];
    currentJson[idx] = {
      ...prev, // title, status, etc remain
      name: entry.name,
      url: entry.previewUrl,
      driveFileId: entry.id,
      driveWebView: entry.webViewLink,
      driveDownload: entry.webContentLink,
      thumbnail: entry.thumbnail,
      source: 'drive',
      updatedAt: now
    };
  } else {
    // New item → set default editorial values
    currentJson.push({
      title: niceTitle(entry.name),
      status: 'new',
      name: entry.name,
      url: entry.previewUrl,
      driveFileId: entry.id,
      driveWebView: entry.webViewLink,
      driveDownload: entry.webContentLink,
      thumbnail: entry.thumbnail,
      source: 'drive',
      publishedAt: now
    });
  }

  // (Optional) sort newest first by publishedAt
  currentJson.sort((a, b) => new Date(b.publishedAt || b.updatedAt || 0) - new Date(a.publishedAt || a.updatedAt || 0));

  // 3) Commit back to GitHub
  await axios.put(
    `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${GITHUB_JSON_PATH}`,
    {
      message: `Publish video (Drive read-only): ${entry.name}`,
      content: Buffer.from(JSON.stringify(currentJson, null, 2)).toString('base64'),
      sha
    },
    { headers: ghHeaders }
  );
}

async function processVideos() {
  const processed = await getProcessed();
  const files = await listNewVideos();

  for (const file of files) {
    if (processed.has(file.id)) continue;

    console.log(`Publishing (no copy): ${file.name}`);
    const entry = await getFileLinks(file.id, file.name);
    await updateGithubJson(entry);
    console.log(`Updated GitHub videos.json for: ${entry.name}`);

    await fs.appendFile(PROCESSED_LOG, `${file.id}\n`);
  }
}

processVideos()
  .then(() => console.log('Drive→GitHub (links only) demo complete'))
  .catch(err => {
    console.error(err?.response?.data || err);
    process.exit(1);
  });

// Cloud Functions (optional):
// exports.demoProcessVideos = async (req, res) => {
//   try {
//     await processVideos();
//     res.status(200).send('Processed');
//   } catch (err) {
//     console.error(err?.response?.data || err);
//     res.status(500).send('Error');
//   }
// };
