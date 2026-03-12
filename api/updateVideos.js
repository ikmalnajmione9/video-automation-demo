// api/updateVideos.js
export default async function handler(req, res) {
  // CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth: shared secret
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const GITHUB_PAT = process.env.GITHUB_PAT;
  const REPO_OWNER = process.env.REPO_OWNER || 'ikmalnajmione9';
  const REPO_NAME  = process.env.REPO_NAME  || 'video-automation-demo';
  const JSON_PATH  = process.env.JSON_PATH  || 'videos.json';

  if (!GITHUB_PAT) return res.status(500).json({ error: 'Server misconfigured: missing GITHUB_PAT' });

  // Validate payload
  let body;
  try {
    body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  const { videos } = body || {};
  if (!Array.isArray(videos)) return res.status(400).json({ error: '`videos` must be an array' });

  const allowedStatus = new Set(['new', 'tested', 'deployed', '', undefined]);
  for (const v of videos) {
    if (!v.driveFileId || !v.name || !v.url) {
      return res.status(400).json({ error: 'Each video requires driveFileId, name, url' });
    }
    if (!allowedStatus.has(v.status)) {
      return res.status(400).json({ error: `Invalid status '${v.status}'` });
    }
  }

  // Read current file to get the SHA (required by GitHub to update)
  const ghHeaders = {
    Authorization: `Bearer ${GITHUB_PAT}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'video-automation-admin'
  };
  const base = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(JSON_PATH)}`;

  let sha;
  try {
    const resp = await fetch(base, { headers: ghHeaders });
    if (resp.status === 200) {
      const data = await resp.json();
      sha = data.sha;
    } else if (resp.status !== 404) {
      const txt = await resp.text();
      return res.status(502).json({ error: `GitHub GET failed: ${resp.status}`, body: txt });
    }
  } catch (e) {
    return res.status(502).json({ error: 'GitHub GET error', details: String(e) });
  }

  // Commit new content
  const newContent = Buffer.from(JSON.stringify(videos, null, 2), 'utf8').toString('base64');
  try {
    const putResp = await fetch(base, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Update videos (UI edit)', content: newContent, sha })
    });
    if (!putResp.ok) {
      const txt = await putResp.text();
      return res.status(502).json({ error: `GitHub PUT failed: ${putResp.status}`, body: txt });
    }
  } catch (e) {
    return res.status(502).json({ error: 'GitHub PUT error', details: String(e) });
  }

  return res.status(200).json({ ok: true });
}
