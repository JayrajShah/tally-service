const express = require("express");
const axios = require("axios");
const xml2js = require("xml2js");
const cron = require("node-cron");
const fs = require("fs");

const app = express();
app.use(express.json());

// Configure
const TALLY_HOST = process.env.TALLY_HOST || "localhost";
const TALLY_PORT = process.env.TALLY_PORT || "9000";
const TALLY_URL = `http://${TALLY_HOST}:${TALLY_PORT}`;

async function postXmlToTally(xml) {
  try {
    const res = await axios.post(TALLY_URL, xml, {
      headers: { "Content-Type": "text/xml" },
      timeout: 30_000,
    });
    // Parse XML -> JS object
    const parsed = await xml2js.parseStringPromise(res.data, {
      explicitArray: false,
      trim: true,
    });
    return parsed;
  } catch (err) {
    console.error("Tally request failed", err.message || err);
    throw err;
  }
}

function ledgerListXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
  <ENVELOPE>
    <HEADER>
      <TALLYREQUEST>Export Data</TALLYREQUEST>
    </HEADER>
    <BODY>
      <EXPORTDATA>
        <REQUESTDESC>
          <REPORTNAME>List of Ledgers</REPORTNAME>
          <STATICVARIABLES>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          </STATICVARIABLES>
        </REQUESTDESC>
      </EXPORTDATA>
    </BODY>
  </ENVELOPE>`;
}

// Example endpoint to trigger fetch and return JSON
app.get("/fetch-ledgers", async (req, res) => {
  try {
    const xml = ledgerListXml();
    const parsed = await postXmlToTally(xml);
    // parsed structure depends on Tally response layout; inspect it
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/parse-xml", (req, res) => {
  const xmldata = fs.readFileSync("example.xml", "utf-8");
  xml2js.parseString(
    xmldata,
    { explicitArray: false, trim: true },
    (err, result) => {
      if (err) {
        return res.status(500).send("Error parsing XML");
      }
      res.json(result);
    }
  );
});

cron.schedule("0 * * * *", async () => {
  console.log("Scheduled: fetching ledgers from Tally");
  try {
    const parsed = await postXmlToTally(ledgerListXml());
    // TODO: transform parsed -> DB model and upsert into DB
    console.log("Fetched ledgers. Sample keys:", Object.keys(parsed || {}));
  } catch (err) {
    console.error("Scheduled fetch failed:", err.message);
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Service listening on ${PORT}`));
