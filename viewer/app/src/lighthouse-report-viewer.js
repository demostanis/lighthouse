/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import idbKeyval from 'idb-keyval';

import {DragAndDrop} from './drag-and-drop.js';
import {GithubApi} from './github-api.js';
import {PSIApi} from './psi-api';
import {ViewerUIFeatures} from './viewer-ui-features.js';
import {DOM} from '../../../report/renderer/dom.js';
import {ReportRenderer} from '../../../report/renderer/report-renderer.js';
import {TextEncoding} from '../../../report/renderer/text-encoding.js';
import {renderFlowReport} from '../../../flow-report/api';

const dom = new DOM(document, document.documentElement);

/* global logger ReportGenerator */

/** @typedef {import('./psi-api').PSIParams} PSIParams */

/**
 * Class that manages viewing Lighthouse reports.
 */
export class LighthouseReportViewer {
  constructor() {
    this._onPaste = this._onPaste.bind(this);
    this._onSaveJson = this._onSaveJson.bind(this);
    this._onFileLoad = this._onFileLoad.bind(this);
    this._onUrlInputChange = this._onUrlInputChange.bind(this);

    this._dragAndDropper = new DragAndDrop(this._onFileLoad);
    this._github = new GithubApi();

    this._psi = new PSIApi();
    /**
     * Used for tracking whether to offer to upload as a gist.
     * @type {boolean}
     */
    this._reportIsFromGist = false;
    this._reportIsFromPSI = false;
    this._reportIsFromJSON = false;

    this._addEventListeners();
    this._loadFromDeepLink();
    this._listenForMessages();
  }

  static get APP_URL() {
    return `${location.origin}${location.pathname}`;
  }

  /**
   * Initialize event listeners.
   * @private
   */
  _addEventListeners() {
    document.addEventListener('paste', this._onPaste);

    const gistUrlInput = dom.find('.js-gist-url');
    gistUrlInput.addEventListener('change', this._onUrlInputChange);

    // Hidden file input to trigger manual file selector.
    const fileInput = dom.find('input#hidden-file-input');
    fileInput.addEventListener('change', e => {
      if (!e.target) {
        return;
      }

      const inputTarget = /** @type {HTMLInputElement} */ (e.target);
      if (inputTarget.files) {
        this._dragAndDropper.readFile(inputTarget.files[0]).then(str => {
          this._onFileLoad(str);
        }).catch(e => logger.error(e));
      }
      inputTarget.value = '';
    });

    const selectFileEl = dom.find('.viewer-placeholder__file-button');
    selectFileEl.addEventListener('click', _ => {
      fileInput.click();
    });
  }

  /**
   * Attempts to pull gist id from URL and render report from it.
   * @return {Promise<void>}
   * @private
   */
  _loadFromDeepLink() {
    const params = new URLSearchParams(location.search);

    const gistId = params.get('gist');
    const psiurl = params.get('psiurl');
    const jsonurl = params.get('jsonurl');
    const gzip = params.get('gzip') === '1';

    const hash = window.__hash ?? location.hash;
    if (hash) {
      try {
        const hashParams = JSON.parse(TextEncoding.fromBase64(hash.substr(1), {gzip}));
        if (hashParams.lhr) {
          this._replaceReportHtml(hashParams.lhr);
          return Promise.resolve();
        } else {
          // eslint-disable-next-line no-console
          console.warn('URL hash is populated, but no LHR was found', hashParams);
        }
      } catch {
        // eslint-disable-next-line no-console
        console.warn('URL hash is populated, but not decoded successfully');
      }
    }

    if (!gistId && !psiurl && !jsonurl) return Promise.resolve();

    this._toggleLoadingBlur(true);
    let loadPromise = Promise.resolve();
    if (psiurl) {
      loadPromise = this._fetchFromPSI({
        url: psiurl,
        category: params.has('category') ? params.getAll('category') : undefined,
        strategy: params.get('strategy') || undefined,
        locale: params.get('locale') || undefined,
        utm_source: params.get('utm_source') || undefined,
      });
    } else if (gistId) {
      loadPromise = this._github.getGistFileContentAsJson(gistId).then(reportJson => {
        this._reportIsFromGist = true;
        this._replaceReportHtml(reportJson);
      }).catch(err => logger.error(err.message));
    } else if (jsonurl) {
      const firebaseAuth = this._github.getFirebaseAuth();
      loadPromise = firebaseAuth.getAccessTokenIfLoggedIn()
        .then(token => {
          return token
            ? Promise.reject(new Error('Can only use jsonurl when not logged in'))
            : null;
        })
        .then(() => fetch(jsonurl))
        .then(resp => resp.json())
        .then(json => {
          this._reportIsFromJSON = true;
          this._replaceReportHtml(json);
        })
        .catch(err => logger.error(err.message));
    }

    return loadPromise.finally(() => this._toggleLoadingBlur(false));
  }

  /**
   * Basic Lighthouse report JSON validation.
   * @param {LH.Result} reportJson
   * @private
   */
  _validateReportJson(reportJson) {
    if (!reportJson.lighthouseVersion) {
      throw new Error('JSON file was not generated by Lighthouse');
    }

    // Leave off patch version in the comparison.
    const semverRe = new RegExp(/^(\d+)?\.(\d+)?\.(\d+)$/);
    const reportVersion = reportJson.lighthouseVersion.replace(semverRe, '$1.$2');
    const lhVersion = window.LH_CURRENT_VERSION.replace(semverRe, '$1.$2');

    if (reportVersion < lhVersion) {
      // TODO: figure out how to handler older reports. All permalinks to older
      // reports will start to throw this warning when the viewer rev's its
      // minor LH version.
      // See https://github.com/GoogleChrome/lighthouse/issues/1108
      logger.warn('Results may not display properly.\n' +
                  'Report was created with an earlier version of ' +
                  `Lighthouse (${reportJson.lighthouseVersion}). The latest ` +
                  `version is ${window.LH_CURRENT_VERSION}.`);
    }
  }

  /**
   * @param {LH.Result | LH.FlowResult} json
   * @return {json is LH.FlowResult}
   */
  _isFlowReport(json) {
    return 'steps' in json && Array.isArray(json.steps);
  }

  /**
   * @param {LH.Result} json
   * @param {HTMLElement} rootEl
   * @param {(json: LH.Result|LH.FlowResult) => void} [saveGistCallback]
   */
  _renderLhr(json, rootEl, saveGistCallback) {
    // Allow users to view the runnerResult
    if ('lhr' in json) {
      const runnerResult = /** @type {{lhr: LH.Result}} */ (/** @type {unknown} */ (json));
      json = runnerResult.lhr;
    }
    // Allow users to drop in PSI's json
    if ('lighthouseResult' in json) {
      const psiResp = /** @type {{lighthouseResult: LH.Result}} */ (/** @type {unknown} */ (json));
      json = psiResp.lighthouseResult;
    }

    // Install as global for easier debugging
    // @ts-expect-error
    window.__LIGHTHOUSE_JSON__ = json;
    // eslint-disable-next-line no-console
    console.log('window.__LIGHTHOUSE_JSON__', json);

    this._validateReportJson(json);

    // Redirect to old viewer if a v2 report. v3, v4, v5 handled by v5 viewer.
    if (json.lighthouseVersion.startsWith('2')) {
      this._loadInLegacyViewerVersion(json);
      return;
    }

    rootEl.classList.add('lh-root', 'lh-vars');
    const reportDom = new DOM(document, rootEl);
    const renderer = new ReportRenderer(reportDom);

    renderer.renderReport(json, rootEl, {
      occupyEntireViewport: true,
    });

    const features = new ViewerUIFeatures(reportDom, {
      saveGist: saveGistCallback,
      refresh: newLhr => {
        this._replaceReportHtml(newLhr);
      },
      getStandaloneReportHTML() {
        return ReportGenerator.generateReportHtml(json);
      },
    });
    features.initFeatures(json);
  }

  /**
   * @param {LH.FlowResult} json
   * @param {HTMLElement} rootEl
   * @param {(json: LH.Result|LH.FlowResult) => void} [saveGistCallback]
   */
  _renderFlowResult(json, rootEl, saveGistCallback) {
    // TODO: Add save HTML functionality with ReportGenerator loaded async.
    renderFlowReport(json, rootEl, {
      saveAsGist: saveGistCallback,
    });
    // Install as global for easier debugging.
    window.__LIGHTHOUSE_FLOW_JSON__ = json;
    // eslint-disable-next-line no-console
    console.log('window.__LIGHTHOUSE_FLOW_JSON__', json);
  }

  /**
   * @param {LH.Result | LH.FlowResult} json
   * @private
   */
  // TODO: Really, `json` should really have type `unknown` and
  // we can have _validateReportJson verify that it's an LH.Result
  _replaceReportHtml(json) {
    const container = dom.find('main');

    // Reset container content.
    container.textContent = '';
    const rootEl = dom.createElement('div');
    container.append(rootEl);

    // Only give gist-saving callback if current report isn't from a gist.
    let saveGistCallback;
    if (!this._reportIsFromGist) {
      saveGistCallback = this._onSaveJson;
    }

    try {
      if (this._isFlowReport(json)) {
        this._renderFlowResult(json, rootEl, saveGistCallback);
        if (window.gtag) window.gtag('event', 'report', {type: 'flow-report'});
      } else {
        this._renderLhr(json, rootEl, saveGistCallback);
        if (window.gtag) window.gtag('event', 'report', {type: 'report'});
      }

      // Only clear query string if current report isn't from a gist or PSI.
      if (!this._reportIsFromGist && !this._reportIsFromPSI && !this._reportIsFromJSON) {
        history.pushState({}, '', LighthouseReportViewer.APP_URL);
      }
    } catch (e) {
      logger.error(`Error rendering report: ${e.stack}`);
      container.textContent = '';
      throw e;
    } finally {
      this._reportIsFromGist = this._reportIsFromPSI = this._reportIsFromJSON = false;
    }

    // Remove the placeholder UI once the user has loaded a report.
    const placeholder = document.querySelector('.viewer-placeholder');
    if (placeholder) {
      placeholder.remove();
    }

    if (window.gtag) {
      window.gtag('event', 'view');
    }
  }

  /**
   * Updates the page's HTML with contents of the JSON file passed in.
   * @param {string} str
   * @throws file was not valid JSON generated by Lighthouse or an unknown file
   *     type was used.
   * @private
   */
  _onFileLoad(str) {
    let json;
    try {
      json = JSON.parse(str);
    } catch (e) {
      logger.error('Could not parse JSON file.');
      return;
    }

    try {
      this._replaceReportHtml(json);
    } catch (err) {
      logger.error(err.message);
    }

    document.dispatchEvent(new CustomEvent('lh-file-upload-test-ack'));
  }

  /**
   * Stores v2.x report in IDB, then navigates to legacy viewer in current tab.
   * @param {LH.Result} reportJson
   * @private
   */
  _loadInLegacyViewerVersion(reportJson) {
    const warnMsg = `Version mismatch between viewer and JSON. Opening compatible viewer...`;
    logger.log(warnMsg, false);

    // Place report in IDB, then navigate current tab to the legacy viewer
    const viewerPath = new URL('../viewer2x/', location.href);
    idbKeyval.set('2xreport', reportJson).then(_ => {
      window.location.href = viewerPath.href;
    });
  }

  /**
   * Saves the current report by creating a gist on GitHub.
   * @param {LH.Result|LH.FlowResult} reportJson
   * @return {Promise<string|void>} id of the created gist.
   * @private
   */
  async _onSaveJson(reportJson) {
    if (window.gtag) {
      window.gtag('event', 'report', {type: 'share'});
    }

    // TODO: find and reuse existing json gist if one exists.
    try {
      const id = await this._github.createGist(reportJson);
      if (window.gtag) {
        window.gtag('event', 'report', {type: 'created'});
      }
      history.pushState({}, '', `${LighthouseReportViewer.APP_URL}?gist=${id}`);
      return id;
    } catch (err) {
      logger.log(err.message);
    }
  }

  /**
   * Enables pasting a JSON report or gist URL on the page.
   * @param {ClipboardEvent} e
   * @private
   */
  _onPaste(e) {
    if (!e.clipboardData) return;
    e.preventDefault();

    // Try paste as gist URL.
    try {
      const url = new URL(e.clipboardData.getData('text'));
      this._loadFromGistURL(url.href);

      if (window.gtag) {
        window.gtag('event', 'report', {type: 'paste-link'});
      }
    } catch (err) {
      // noop
    }

    // Try paste as json content.
    try {
      const json = JSON.parse(e.clipboardData.getData('text'));
      this._replaceReportHtml(json);

      if (window.gtag) {
        window.gtag('event', 'report', {type: 'paste'});
      }
    } catch (err) {
    }
  }

  /**
   * Handles changes to the gist url input.
   * @param {Event} e
   * @private
   */
  _onUrlInputChange(e) {
    e.stopPropagation();

    if (!e.target) {
      return;
    }

    const inputElement = /** @type {HTMLInputElement} */ (e.target);

    try {
      this._loadFromGistURL(inputElement.value);
    } catch (err) {
      logger.error('Invalid URL');
    }
  }

  /**
   * Loads report json from gist URL, if valid. Updates page URL with gist ID
   * and loads from github.
   * @param {string} urlStr Gist URL.
   * @private
   */
  _loadFromGistURL(urlStr) {
    try {
      const url = new URL(urlStr);

      if (url.origin !== 'https://gist.github.com') {
        logger.error('URL was not a gist');
        return;
      }

      const match = url.pathname.match(/[a-f0-9]{5,}/);
      if (match) {
        history.pushState({}, '', `${LighthouseReportViewer.APP_URL}?gist=${match[0]}`);
        this._loadFromDeepLink();
      }
    } catch (err) {
      logger.error('Invalid URL');
    }
  }

  /**
   * Initializes of a `message` listener to respond to postMessage events.
   * @private
   */
  _listenForMessages() {
    window.addEventListener('message', e => {
      if (e.source === self.opener && (e.data.lhr || e.data.lhresults)) {
        this._replaceReportHtml(e.data.lhr || e.data.lhresults);

        if (self.opener && !self.opener.closed) {
          self.opener.postMessage({rendered: true}, '*');
        }
        if (window.gtag) {
          window.gtag('event', 'report', {type: 'open in viewer'});
        }
      }
    });

    // If the page was opened as a popup, tell the opening window we're ready.
    if (self.opener && !self.opener.closed) {
      self.opener.postMessage({opened: true}, '*');
    }
  }

  /**
   * @param {PSIParams} params
   */
  _fetchFromPSI(params) {
    logger.log('Waiting for Lighthouse results ...');
    return this._psi.fetchPSI(params).then(response => {
      logger.hide();

      if (!response.lighthouseResult) {
        if (response.error) {
          // eslint-disable-next-line no-console
          console.error(response.error);
          logger.error(response.error.message);
        } else {
          logger.error('PSI did not return a Lighthouse Result');
        }
        return;
      }

      this._reportIsFromPSI = true;
      this._replaceReportHtml(response.lighthouseResult);
    });
  }

  /**
   * @param {boolean} force
   */
  _toggleLoadingBlur(force) {
    const placeholder = document.querySelector('.viewer-placeholder-inner');
    if (placeholder) placeholder.classList.toggle('lh-loading', force);
  }
}
