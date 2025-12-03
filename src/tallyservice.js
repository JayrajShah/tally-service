// tally-sales-test.js
const axios = require("axios");
const xml2js = require("xml2js");

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000/";
const AXIOS_TIMEOUT = 60_000; // increase if needed

async function postXmlToTallyRaw(xml) {
  try {
    const res = await axios.post(TALLY_URL, xml, {
      headers: { "Content-Type": "text/xml" },
      timeout: AXIOS_TIMEOUT,
    });
    return { status: res.status, data: res.data };
  } catch (err) {
    // capture everything helpful
    const info = {
      message: err.message,
      code: err.code,
      status: err.response?.status,
      responseData: err.response?.data,
    };
    throw info;
  }
}

async function parseXml(xmlString) {
  try {
    return await xml2js.parseStringPromise(xmlString, {
      explicitArray: false,
      trim: true,
    });
  } catch (err) {
    throw { message: "XML parse error", detail: err.message, raw: xmlString };
  }
}

function salesRegisterXml(fromYYYYMMDD, toYYYYMMDD) {
  return `
  <ENVELOPE>
    <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
    <BODY>
      <EXPORTDATA>
        <REQUESTDESC>
          <REPORTNAME>Sales Register</REPORTNAME>
          <STATICVARIABLES>
            <SVFROMDATE TYPE="Date">${fromYYYYMMDD}</SVFROMDATE>
            <SVTODATE TYPE="Date">${toYYYYMMDD}</SVTODATE>
            <SVCURRENTCOMPANY>$$CMPNAME</SVCURRENTCOMPANY>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          </STATICVARIABLES>
        </REQUESTDESC>
      </EXPORTDATA>
    </BODY>
  </ENVELOPE>`;
}

function dayBookXml(fromYYYYMMDD, toYYYYMMDD) {
  return `
  <ENVELOPE>
    <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
    <BODY>
      <EXPORTDATA>
        <REQUESTDESC>
          <REPORTNAME>Day Book</REPORTNAME>
          <STATICVARIABLES>
            <SVFROMDATE TYPE="Date">${fromYYYYMMDD}</SVFROMDATE>
            <SVTODATE TYPE="Date">${toYYYYMMDD}</SVTODATE>
            <SVCURRENTCOMPANY>$$CMPNAME</SVCURRENTCOMPANY>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          </STATICVARIABLES>
        </REQUESTDESC>
      </EXPORTDATA>
    </BODY>
  </ENVELOPE>`;
}

// normalize TALLYMESSAGE into array
function getMessagesArray(dataObj) {
  const msgs = dataObj?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE;
  if (!msgs) return [];
  return Array.isArray(msgs) ? msgs : [msgs];
}

// extract vouchers from TALLYMESSAGE array
function extractVouchers(messages) {
  const vouchers = [];
  for (const msg of messages) {
    if (msg.VOUCHER) {
      vouchers.push(msg.VOUCHER);
    }
  }
  return vouchers;
}

// filter vouchers by VOUCHERTYPENAME or VCHTYPE equals 'Sales'
function filterSalesVouchers(vouchers) {
  return vouchers.filter((v) => {
    const vt = v.VOUCHERTYPENAME || v.VCHTYPE || "";
    return String(vt).toLowerCase().includes("sales");
  });
}

// main function: try Sales Register, fallback to Day Book -> filter
async function fetchSales(fromYYYYMMDD, toYYYYMMDD) {
  // 1) Try Sales Register
  let xml = salesRegisterXml(fromYYYYMMDD, toYYYYMMDD);
  try {
    const raw = await postXmlToTallyRaw(xml);
    console.log("Tally responded (Sales Register) status:", raw.status);
    const parsed = await parseXml(raw.data);
    const messages = getMessagesArray(parsed);
    const vouchers = extractVouchers(messages);
    if (vouchers.length) {
      console.log(`Sales Register returned ${vouchers.length} vouchers`);
      return vouchers;
    }
    // maybe Sales Register exists but returned 0; return parsed (empty) to caller
    return vouchers;
  } catch (err) {
    console.error(
      "Sales Register attempt failed. Error summary:",
      err.message || err
    );
    if (err.responseData) {
      console.error(
        "--- RAW TALLY RESPONSE (Sales Register) ---\n",
        err.responseData
      );
      // If it's a LINEERROR about report name, we proceed to fallback
      try {
        const parsedErr = await parseXml(err.responseData);
        const lineErr =
          parsedErr?.RESPONSE?.LINEERROR ||
          parsedErr?.ENVELOPE?.BODY?.RESPONSE?.LINEERROR;
        if (lineErr) console.error("Tally LINEERROR:", lineErr);
      } catch (_) {
        /* ignore parse error here */
      }
    }

    // 2) Fallback -> Day Book and filter Sales
    console.log("Falling back to Day Book + filter for Sales vouchers...");
    try {
      const raw2 = await postXmlToTallyRaw(
        dayBookXml(fromYYYYMMDD, toYYYYMMDD)
      );
      console.log("Tally responded (Day Book) status:", raw2.status);
      const parsed2 = await parseXml(raw2.data);
      const msgs2 = getMessagesArray(parsed2);
      const vchs = extractVouchers(msgs2);
      const sales = filterSalesVouchers(vchs);
      console.log(
        `Day Book returned ${vchs.length} vouchers; filtered Sales = ${sales.length}`
      );
      return sales;
    } catch (err2) {
      console.error(
        "Day Book fallback failed. Raw error summary:",
        err2.message || err2
      );
      if (err2.responseData) {
        console.error(
          "--- RAW TALLY RESPONSE (Day Book) ---\n",
          err2.responseData
        );
      }
      throw new Error(
        "Both Sales Register and Day Book attempts failed; check raw logs above."
      );
    }
  }
}

// Helper: chunk by month range (YYYYMM) -> returns array of {from,to}
function monthChunksBetween(startYYYYMMDD, endYYYYMMDD) {
  const start = new Date(
    `${startYYYYMMDD.slice(0, 4)}-${startYYYYMMDD.slice(
      4,
      6
    )}-${startYYYYMMDD.slice(6, 8)}`
  );
  const end = new Date(
    `${endYYYYMMDD.slice(0, 4)}-${endYYYYMMDD.slice(4, 6)}-${endYYYYMMDD.slice(
      6,
      8
    )}`
  );
  const chunks = [];
  let cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur <= end) {
    const year = cur.getFullYear();
    const month = cur.getMonth(); // 0-based
    const from = new Date(year, month, 1);
    const to = new Date(year, month + 1, 0); // last day of month
    const fromStr = `${from.getFullYear()}${String(
      from.getMonth() + 1
    ).padStart(2, "0")}${String(from.getDate()).padStart(2, "0")}`;
    const toStr = `${to.getFullYear()}${String(to.getMonth() + 1).padStart(
      2,
      "0"
    )}${String(to.getDate()).padStart(2, "0")}`;
    chunks.push({ from: fromStr, to: toStr });
    cur = new Date(year, month + 1, 1);
  }
  return chunks;
}

// Example usage: fetch month-by-month between two dates
(async () => {
  try {
    const start = "20251101";
    const end = "20251121";
    const chunks = monthChunksBetween(start, end);
    let all = [];
    for (const c of chunks) {
      console.log(`Fetching ${c.from} -> ${c.to}`);
      const v = await fetchSales(c.from, c.to);
      console.log(`Got ${v.length} vouchers for ${c.from}->${c.to}`);
      all = all.concat(v);
      // small delay to avoid overwhelming Tally
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`Total sales vouchers fetched: ${all.length}`);
    // Optionally map to compact JSON here
    // console.dir(all, { depth: 2 });
  } catch (err) {
    console.error("Fatal error:", err);
  }
})();
