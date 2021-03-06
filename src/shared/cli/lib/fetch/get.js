/* eslint-disable import/prefer-default-export */

import needle from 'needle';
import * as caching from './caching.js';
import datetime from '../datetime/index.js';
import log from '../log.js';

const CHROME_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.132 Safari/537.36';

const OPEN_TIMEOUT = 5000;
const RESPONSE_TIMEOUT = 5000;
const READ_TIMEOUT = 30000;

// Spoof Chrome, just in case
needle.defaults({
  parse_response: false,
  user_agent: CHROME_AGENT,
  open_timeout: OPEN_TIMEOUT, // Maximum time to wait to establish a connection
  response_timeout: RESPONSE_TIMEOUT, // Maximum time to wait for a response
  read_timeout: READ_TIMEOUT, // Maximum time to wait for data to transfer
  follow_max: 5 // follow up to five redirects
});

/**
 * Fetch whatever is at the provided URL. Use cached version if available.
 * @param {*} scraper the scraper object
 * @param {string} url URL of the resource
 * @param {*} type type of the resource
 * @param {*} date the date associated with this resource, or false if a timeseries data
 * @param {object} options customizable options:
 *  - alwaysRun: fetches from URL even if resource is in cache, defaults to false
 *  - disableSSL: disables SSL verification for this resource, should be avoided
 *  - toString: returns data as a string instead of buffer, defaults to true
 *  - encoding: encoding to use when retrieving files from cache, defaults to utf8
 *  - method: 'get' or 'post'
 *  - args: key/value pairs to send with a POST
 *
 * Returns: { body: body, cookies: cookies }.  If the request failed,
 * both body and cookies are null.
 */
export const get = async (
  scraper,
  url,
  cacheKey,
  type,
  date = datetime.old.scrapeDate() || datetime.old.getYYYYMD(),
  options = {}
) => {
  const { alwaysRun, disableSSL, toString, encoding, cookies, headers, method, args } = {
    alwaysRun: false,
    disableSSL: false,
    toString: true,
    encoding: 'utf8',
    cookies: undefined,
    headers: undefined,
    method: 'get',
    args: undefined,
    ...options
  };

  if (scraper === null || typeof scraper !== 'object') throw new Error(`null or invalid scraper, getting ${url}`);

  const cachedBody = await caching.getCachedFile(scraper, url, cacheKey, type, date, encoding);
  if (process.env.ONLY_USE_CACHE) return { body: cachedBody, cookies: null };

  if (cachedBody === caching.CACHE_MISS || alwaysRun) {
    log('  🚦  Loading data for %s from server', url);

    if (disableSSL) {
      log('  ⚠️  SSL disabled for this resource');
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }

    // Allow a second chance if we encounter a recoverable error
    let tries = 0;
    while (tries < 5) {
      tries++;
      if (tries > 1) {
        // sleep a moment before retrying
        log(`  ⚠️  Retrying (${tries})...`);
        await new Promise(r => setTimeout(r, 2000));
      }

      // TODO @AWS: if AWS infra get from endpoint instead of needle

      let errorMsg = '';
      const response = await needle(method, url, args, { cookies, headers }).catch(err => {
        // Errors we get here have the tendency of crashing the whole crawler
        // with no ability for us to catch them. Let's hear what these errors have to say,
        // and throw an error later down that won't bring the whole process down.
        errorMsg = err.toString();
      });

      if (disableSSL) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      }

      // try again if we got an error
      if (errorMsg) {
        log.error(`  ❌ Got ${errorMsg} trying to fetch ${url}`);
        continue;
      }
      // try again if we got an error code which might be recoverable
      if (response.statusCode >= 500) {
        log.error(`  ❌ Got error ${response.statusCode} trying to fetch ${url}`);
        continue;
      }

      const contentLength = parseInt(response.headers['content-length'], 10);
      if (!Number.isNaN(contentLength) && contentLength !== response.bytes) {
        log.error(`  ❌ Got ${response.bytes} but expecting ${contentLength} fetching ${url}`);
        continue;
      }

      // any sort of success code -- return good data
      if (response.statusCode < 400) {
        const fetchedBody = toString ? response.body.toString() : response.body;
        await caching.saveFileToCache(scraper, url, type, date, fetchedBody);
        return { body: fetchedBody, cookies: response.cookies };
      }

      // 400-499 means "not found" and a retry probably won't help -- return null
      log.error(`  ❌ Got error ${response.statusCode} trying to fetch ${url}`);
      return { body: null, cookies: null };
    }

    log.error(`  ❌ Failed to fetch ${url} after ${tries} tries`);
    return { body: null, cookies: null };
  }

  return { body: cachedBody, cookies: null };
};
