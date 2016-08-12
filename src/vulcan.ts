/**
 * @license
 * Copyright (c) 2014 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */

/// <reference path="../node_modules/@types/node/index.d.ts" />
'use strict';

const path = require('path');
const url = require('url');
const pathPosix = path.posix || require('path-posix');
const dom5 = require('dom5');
const CommentMap = require('./comment-map');
const constants = require('./constants');
const matchers = require('./matchers');
const PathResolver = require('./pathresolver');
const encodeString = require('../third_party/UglifyJS2/output');

// let Promise = global.Promise;

import {Analyzer, Options as AnalyzerOptions} from 'polymer-analyzer';
import {UrlLoader} from 'polymer-analyzer/lib/url-loader/url-loader';
import {FSUrlLoader} from 'polymer-analyzer/lib/url-loader/fs-url-loader';

/**
 * This is the copy of vulcanize we keep to simulate the setOptions api.
 *
 * TODO(garlicnation): deprecate and remove setOptions API in favor of constructor.
 */
let singleton;

function buildLoader(config) {
  const abspath = config.abspath;
  const excludes = config.excludes;
  const fsResolver = config.fsResolver;
  const redirects = config.redirects;
  let root = abspath && path.resolve(abspath) || process.cwd;
  let loader = new FSUrlLoader(root);
  // TODO(garlicnation): Add noopResolver for external urls.
  // TODO(garlicnation): Add redirectResolver for fakeprotocol:// urls
  // TODO(garlicnation): Add noopResolver for excluded urls.
  return loader;
}

class Vulcan {
  constructor(opts) {
      // implicitStrip should be true by default
    this.implicitStrip = opts.implicitStrip === undefined ? true : Boolean(opts.implicitStrip);
    this.abspath = (String(opts.abspath) === opts.abspath && String(opts.abspath).trim() !== '') ? path.resolve(opts.abspath) : null;
    this.pathResolver = new PathResolver(this.abspath);
    this.addedImports = Array.isArray(opts.addedImports) ? opts.addedImports : [];
    this.excludes = Array.isArray(opts.excludes) ? opts.excludes : [];
    this.stripExcludes = Array.isArray(opts.stripExcludes) ? opts.stripExcludes : [];
    this.stripComments = Boolean(opts.stripComments);
    this.enableCssInlining = Boolean(opts.inlineCss);
    this.enableScriptInlining = Boolean(opts.inlineScripts);
    this.inputUrl = String(opts.inputUrl) === opts.inputUrl ? opts.inputUrl : '';
    this.fsResolver = opts.fsResolver;
    this.redirects = Array.isArray(opts.redirects) ? opts.redirects : [];
    if (opts.loader) {
      this.loader = opts.loader;
    } else {
      this.loader = buildLoader({
        abspath: this.abspath,
        fsResolver: this.fsResolver,
        excludes: this.excludes,
        redirects: this.redirects
      });
    }
  }

  static process(target, cb) {
    singleton.process(target, cb);
  }

  static setOptions(opts) {
    singleton = new Vulcan(opts);
  }
}

Vulcan.prototype = {
  isDuplicateImport: function isDuplicateImport(importMeta) {
    return !importMeta.href;
  },

  reparent: function reparent(newParent) {
    return function(node) {
      node.parentNode = newParent;
    };
  },

  isExcludedImport: function isExcludedImport(importMeta) {
    return this.isExcludedHref(importMeta.href);
  },

  isExcludedHref: function isExcludedHref(href) {
    if (constants.EXTERNAL_URL.test(href)) {
      return true;
    }
    if (!this.excludes) {
      return false;
    }
    return this.excludes.some(function(r) {
      return href.search(r) >= 0;
    });
  },

  isStrippedImport: function isStrippedImport(importMeta) {
    if (!this.stripExcludes.length) {
      return false;
    }
    const href = importMeta.href;
    return this.stripExcludes.some(function(r) {
      return href.search(r) >= 0;
    });
  },

  isBlankTextNode: function isBlankTextNode(node) {
    return node && dom5.isTextNode(node) && !/\S/.test(dom5.getTextContent(node));
  },

  hasOldPolymer: function hasOldPolymer(doc) {
    return Boolean(dom5.query(doc, matchers.polymerElement));
  },

  removeElementAndNewline: function removeElementAndNewline(node, replacement) {
    // when removing nodes, remove the newline after it as well
    const parent = node.parentNode;
    const nextIdx = parent.childNodes.indexOf(node) + 1;
    const next = parent.childNodes[nextIdx];
    // remove next node if it is blank text
    if (this.isBlankTextNode(next)) {
      dom5.remove(next);
    }
    if (replacement) {
      dom5.replace(node, replacement);
    } else {
      dom5.remove(node);
    }
  },

  isLicenseComment: function(node) {
    if (dom5.isCommentNode(node)) {
      return dom5.getTextContent(node).indexOf('@license') > -1;
    }
    return false;
  },

  moveToBodyMatcher: dom5.predicates.AND(
    dom5.predicates.OR(
      dom5.predicates.hasTagName('script'),
      dom5.predicates.hasTagName('link')
    ),
    dom5.predicates.NOT(
      matchers.polymerExternalStyle
    )
  ),

  ancestorWalk: function(node, target) {
    while(node) {
      if (node === target) {
        return true;
      }
      node = node.parentNode;
    }
    return false;
  },

  isTemplated: function(node) {
    while(node) {
      if (dom5.isDocumentFragment(node)) {
        return true;
      }
      node = node.parentNode;
    }
    return false;
  },

  flatten: function flatten(tree, isMainDoc) {
    const doc = tree.html.ast;
    const imports = tree.imports;
    const head = dom5.query(doc, matchers.head);
    const body = dom5.query(doc, matchers.body);
    const importNodes = tree.html.import;
    // early check for old polymer versions
    if (this.hasOldPolymer(doc)) {
      throw new Error(constants.OLD_POLYMER + ' File: ' + this.pathResolver.urlToPath(tree.href));
    }
    this.fixFakeExternalScripts(doc);
    this.pathResolver.acid(doc, tree.href);
    let moveTarget;
    if (isMainDoc) {
      // hide bodies of imports from rendering in main document
      moveTarget = dom5.constructors.element('div');
      dom5.setAttribute(moveTarget, 'hidden', '');
      dom5.setAttribute(moveTarget, 'by-vulcanize', '');
    } else {
      moveTarget = dom5.constructors.fragment();
    }
    head.childNodes.filter(this.moveToBodyMatcher).forEach(function(n) {
      this.removeElementAndNewline(n);
      dom5.append(moveTarget, n);
    }, this);
    this.prepend(body, moveTarget);
    if (imports) {
      for (let i = 0, im, thisImport; i < imports.length; i++) {
        im = imports[i];
        thisImport = importNodes[i];
        if (this.isDuplicateImport(im) || this.isStrippedImport(im)) {
          this.removeElementAndNewline(thisImport);
          continue;
        }
        if (this.isExcludedImport(im)) {
          continue;
        }
        if (this.isTemplated(thisImport)) {
          continue;
        }
        const bodyFragment = dom5.constructors.fragment();
        const importDoc = this.flatten(im);
        // rewrite urls
        this.pathResolver.resolvePaths(importDoc, im.href, tree.href);
        const importHead = dom5.query(importDoc, matchers.head);
        const importBody = dom5.query(importDoc, matchers.body);
        // merge head and body tags for imports into main document
        const importHeadChildren = importHead.childNodes;
        const importBodyChildren = importBody.childNodes;
        // make sure @license comments from import document make it into the import
        const importHtml = importHead.parentNode;
        const licenseComments = importDoc.childNodes.concat(importHtml.childNodes).filter(this.isLicenseComment);
        // move children of <head> and <body> into importer's <body>
        const reparentFn = this.reparent(bodyFragment);
        importHeadChildren.forEach(reparentFn);
        importBodyChildren.forEach(reparentFn);
        bodyFragment.childNodes = bodyFragment.childNodes.concat(
          licenseComments,
          importHeadChildren,
          importBodyChildren
        );
        // hide imports in main document, unless already hidden
        if (isMainDoc && !this.ancestorWalk(thisImport, moveTarget)) {
          this.hide(thisImport);
        }
        this.removeElementAndNewline(thisImport, bodyFragment);
      }
    }
    // If hidden node is empty, remove it
    if (isMainDoc && moveTarget.childNodes.length === 0) {
      dom5.remove(moveTarget);
    }
    return doc;
  },

  hide: function(node) {
    const hidden = dom5.constructors.element('div');
    dom5.setAttribute(hidden, 'hidden', '');
    dom5.setAttribute(hidden, 'by-vulcanize', '');
    this.removeElementAndNewline(node, hidden);
    dom5.append(hidden, node);
  },

  prepend: function prepend(parent, node) {
    if (parent.childNodes.length) {
      dom5.insertBefore(parent, parent.childNodes[0], node);
    } else {
      dom5.append(parent, node);
    }
  },

  fixFakeExternalScripts: function fixFakeExternalScripts(doc) {
    const scripts = dom5.queryAll(doc, matchers.JS_INLINE);
    scripts.forEach(function(script) {
      if (script.__hydrolysisInlined) {
        dom5.setAttribute(script, 'src', script.__hydrolysisInlined);
        dom5.setTextContent(script, '');
      }
    });
  },

  // inline scripts into document, returns a promise resolving to document.
  inlineScripts: function inlineScripts(doc, href) {
    const scripts = dom5.queryAll(doc, matchers.JS_SRC);
    const scriptPromises = scripts.map(function(script) {
      const src = dom5.getAttribute(script, 'src');
      const uri = url.resolve(href, src);
      // let the loader handle the requests
      if (this.isExcludedHref(src)) {
        return Promise.resolve(true);
      }
      return this.loader.request(uri).then(function(content) {
        if (content) {
          content = encodeString(content);
          dom5.removeAttribute(script, 'src');
          dom5.setTextContent(script, content);
        }
      });
    }.bind(this));
    // When all scripts are read, return the document
    return Promise.all(scriptPromises).then(function(){ return {doc: doc, href: href}; });
  },


  // inline scripts into document, returns a promise resolving to document.
  inlineCss: function inlineCss(doc, href) {
    const css_links = dom5.queryAll(doc, matchers.ALL_CSS_LINK);
    const cssPromises = css_links.map(function(link) {
      const tag = link;
      const src = dom5.getAttribute(tag, 'href');
      const media = dom5.getAttribute(tag, 'media');
      const uri = url.resolve(href, src);
      const isPolymerExternalStyle = matchers.polymerExternalStyle(tag);

      // let the loader handle the requests
      if (this.isExcludedHref(src)) {
        return Promise.resolve(true);
      }
      // let the loader handle the requests
      return this.loader.request(uri).then(function(content) {
        if (content) {
          content = this.pathResolver.rewriteURL(uri, href, content);
          if (media) {
            content = '@media ' + media + ' {' + content + '}';
          }
          const style = dom5.constructors.element('style');
          dom5.setTextContent(style, '\n' + content + '\n');

          if (isPolymerExternalStyle) {
            // a polymer expternal style <link type="css" rel="import"> must be
            // in a <dom-module> to be processed
            const ownerDomModule = dom5.nodeWalkPrior(tag, dom5.predicates.hasTagName('dom-module'));
            if (ownerDomModule) {
              let domTemplate = dom5.query(ownerDomModule, dom5.predicates.hasTagName('template'));
              if (!domTemplate) {
                // create a <template>, which has a fragment as childNodes[0]
                domTemplate = dom5.constructors.element('template');
                domTemplate.childNodes.push(dom5.constructors.fragment());
                dom5.append(ownerDomModule, domTemplate);
              }
              dom5.remove(tag);
              // put the style at the top of the dom-module's template
              this.prepend(domTemplate.childNodes[0], style);
            }
          } else {
            dom5.replace(tag, style);
          }
        }
      }.bind(this));
    }.bind(this));
    // When all style imports are read, return the document
    return Promise.all(cssPromises).then(function(){ return {doc: doc, href: href}; });
  },

  getImplicitExcludes: function getImplicitExcludes(excludes) {
    // Build a loader that doesn't have to stop at our excludes, since we need them.
    const loader = buildLoader({
      abspath: this.abspath,
      fsResolver: this.fsResolver,
      redirects: this.redirects
    });
    const analyzer = new analyzer.Analyzer(true, loader);
    const analyzedExcludes = [];
    excludes.forEach(function(exclude) {
      if (exclude.match(/.js$/)) {
        return;
      }
      if (exclude.match(/.css$/)) {
        return;
      }
      if (exclude.slice(-1) === '/') {
        return;
      }
      const depPromise = analyzer._getDependencies(exclude);
      depPromise.catch(function(err) {
        // include that this was an excluded url in the error message.
        err.message += '. Could not read dependencies for excluded URL: ' + exclude;
      });
      analyzedExcludes.push(depPromise);
    });
    return Promise.all(analyzedExcludes).then(function(strippedExcludes) {
      const dedupe = {};
      strippedExcludes.forEach(function(excludeList){
        excludeList.forEach(function(exclude) {
          dedupe[exclude] = true;
        });
      });
      return Object.keys(dedupe);
    });
  },

  _process: function _process(target, cb) {
    let chain = Promise.resolve(true);
    if (this.implicitStrip && this.excludes) {
      chain = this.getImplicitExcludes(this.excludes).then(function(implicitExcludes) {
        implicitExcludes.forEach(function(strippedExclude) {
          this.stripExcludes.push(strippedExclude);
        }.bind(this));
      }.bind(this));
    }
    const analyzer = new analyzer.Analyzer(true, this.loader);
    chain = chain.then(function(){
      return analyzer.metadataTree(target);
    }).then(function(tree) {
      const flatDoc = this.flatten(tree, true);
      // make sure there's a <meta charset> in the page to force UTF-8
      let meta = dom5.query(flatDoc, matchers.meta);
      const head = dom5.query(flatDoc, matchers.head);
      for (let i = 0; i < this.addedImports.length; i++) {
        const newImport = dom5.constructors.element('link');
        dom5.setAttribute(newImport, 'rel', 'import');
        dom5.setAttribute(newImport, 'href', this.addedImports[i]);
        this.prepend(head, newImport);
      }
      if (!meta) {
        meta = dom5.constructors.element('meta');
        dom5.setAttribute(meta, 'charset', 'UTF-8');
        this.prepend(head, meta);
      }
      return {doc: flatDoc, href: tree.href};
    }.bind(this));
    if (this.enableScriptInlining) {
      chain = chain.then(function(docObj) {
        return this.inlineScripts(docObj.doc, docObj.href);
      }.bind(this));
    }
    if (this.enableCssInlining) {
      chain = chain.then(function(docObj) {
        return this.inlineCss(docObj.doc, docObj.href);
      }.bind(this));
    }
    if (this.stripComments) {
      chain = chain.then(function(docObj) {
        const comments = new CommentMap();
        const doc = docObj.doc;
        const head = dom5.query(doc, matchers.head);
        // remove all comments
        dom5.nodeWalkAll(doc, dom5.isCommentNode).forEach(function(comment) {
          comments.set(comment.data, comment);
          dom5.remove(comment);
        });
        // Deduplicate license comments
        comments.keys().forEach(function (commentData) {
          if (commentData.indexOf("@license") == -1) {
            return;
          }
          this.prepend(head, comments.get(commentData));
        }, this);
        return docObj;
      }.bind(this));
    }
    chain.then(function(docObj) {
      cb(null, dom5.serialize(docObj.doc));
    }).catch(cb);
  },

  process: function process(target, cb) {
    if (this.inputUrl) {
      this._process(this.inputUrl, cb);
    } else {
      if (this.abspath) {
        target = pathPosix.resolve('/', target);
      } else {
        target = this.pathResolver.pathToUrl(path.resolve(target));
      }
      this._process(target, cb);
    }
  }
};

module.exports = Vulcan;