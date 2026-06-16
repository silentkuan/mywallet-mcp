const { GoogleAuth } = require('google-auth-library');
require('dotenv').config({ path: '/opt/mywallet-mcp/.env' });
const https = require('https');

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
let privateKey = process.env.FIREBASE_PRIVATE_KEY;
if (privateKey) privateKey = privateKey.replace(/\\n/g, '\n');

const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}`;

function httpsReq(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: data.substring(0,200) }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  try {
    const auth = new GoogleAuth({
      credentials: { project_id: projectId, client_email: clientEmail, private_key: privateKey },
      scopes: ['https://www.googleapis.com/auth/firebase'],
    });
    const client = await auth.getClient();
    const tokenResp = await client.getAccessToken();
    const token = tokenResp.token;
    console.log('✅ Got access token');
    const H = { Authorization: `Bearer ${token}` };

    // Step 1: List existing rulesets
    const listUrl = `https://firebaserules.googleapis.com/v1/projects/${projectId}/rulesets`;
    const listRes = await httpsReq(listUrl, 'GET', H, null);
    if (listRes.data && listRes.data.rulesets) {
      console.log(`Existing rulesets: ${listRes.data.rulesets.length}`);
    } else {
      console.log('No existing rulesets');
    }

    // Step 2: Create new ruleset
    console.log('\nCreating ruleset...');
    const createRes = await httpsReq(listUrl, 'POST', H, {
      source: {
        files: [{
          name: 'firestore.rules',
          content: rules,
        }]
      }
    });
    
    if (createRes.status >= 400) {
      console.error('❌ Create ruleset failed:', createRes.status, JSON.stringify(createRes.data));
      return;
    }
    const rulesetName = createRes.data.name;
    console.log(`✅ Ruleset created: ${rulesetName}`);

    // Step 3: Create release (POST to /releases)
    console.log('\nCreating release...');
    const releaseUrl = `https://firebaserules.googleapis.com/v1/projects/${projectId}/releases`;
    const createRelRes = await httpsReq(releaseUrl, 'POST', H, {
      name: `projects/${projectId}/releases/cloud.firestore`,
      rulesetName: rulesetName,
    });
    
    if (createRelRes.status < 400) {
      console.log(`✅ Release created: ${createRelRes.status}`);
      console.log(`   Name: ${createRelRes.data.name}`);
      console.log(`   Ruleset: ${createRelRes.data.rulesetName}`);
    } else {
      console.error(`❌ Create release failed: ${createRelRes.status}`);
      console.error(JSON.stringify(createRelRes.data));
      
      // Maybe it already exists and we need to PATCH
      if (createRelRes.status === 409 || createRelRes.status === 400) {
        console.log('Trying PATCH instead...');
        // The name for PATCH includes the full release name
        const patchUrl = `https://firebaserules.googleapis.com/v1/projects/${projectId}/releases/cloud.firestore`;
        const patchRes = await httpsReq(patchUrl, 'PATCH', H, {
          rulesetName: rulesetName,
        });
        console.log(`PATCH result: ${patchRes.status}`, JSON.stringify(patchRes.data).substring(0,200));
      }
    }

    console.log('\n🎉 Done!');
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

main();
