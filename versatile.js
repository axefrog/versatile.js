(function() {

	var fs = require('fs');
	var _ = require('underscore');
	var Q = require('q');
	var filters = [];

	var fileTypes = {};
	var docs = [];

	function log(type, msg) {
		module.exports.log(type, msg);
	}

	function trim(s) {
		return (s || '').replace(/^\s*(.*?)\s*$/, '$1');
	}

	function removeTrailingEmptyLines(lines) {
		while(lines && lines.length && !_.last(lines))
			lines.pop();
	}

	function filterValue(key, value, filters, doc) {
		for(var i in filters)
			value = filters[i](value, doc, key);
		return value;
	}

	function parseKey(key) {
		var arr = key.split(':');
		var result = { key: arr[0], filters: [] };
		for(var i = 1; i < arr.length; i++) {
			var filter = filters[arr[i]];
			if(filter === undefined)
				return null;
			result.filters.push(filter);
		};
		return result;
	}

	function parseLine(line) {
		var match = /^@@\s*([a-z0-9_]+(:[a-z0-9_]+)*)(\s+(.*?)\s*)?$/gi.exec(line);
		if(match) {
			var result = parseKey(match[1]);
			if(result) {
				var last = _.last(match);
				if(last && trim(last))
					result.text = last;
				return result;
			}
		}
		return { text:line || '' };
	}

	function applyCurrentValToDoc(doc, val) {
		removeTrailingEmptyLines(val.lines);
		if(val.lines.length)
			doc[val.key] = filterValue(val.key, val.lines.join('\n'), val.filters, doc);
	}

	function addToDocs(doc) {
		if(!_.keys(doc).length)
			return;

		docs.push(doc);
		if(doc.id === undefined)
			doc.id = doc.filename;
		if(doc.id && docs[doc.id] === undefined)
			docs[doc.id] = doc;
	}

	function buildDoc(ctx) {
		_.each(ctx.lines, function processLine(line, index) {
			
			var parsedLine = parseLine(line);
			if(parsedLine.key) {
				if(parsedLine.text)
					ctx.doc[parsedLine.key] = filterValue(parsedLine.key, trim(parsedLine.text), parsedLine.filters || [], ctx.doc);
				else {
					applyCurrentValToDoc(ctx.doc, ctx.current);
					ctx.current = {
						key:     parsedLine.key,
						filters: parsedLine.filters,
						lines:   []
					};
				}
			}
			else if(ctx.current.lines.length || parsedLine.text)
				ctx.current.lines.push(parsedLine.text);
			
			if(index == ctx.lines.length - 1)
				applyCurrentValToDoc(ctx.doc, ctx.current);
		});
	}

	function processJsDocument(filename, ext, callback) {
		fs.readFile(filename, 'utf8', function onReadfileComplete(err, text) {
			ext = ext.substr(1);

			if(!err) {
				try {
					var jsobj;
					var doc = ext == 'js' ? eval('jsobj = ' + text) : JSON.parse(text);
					if(typeof doc != 'object')
						err = new Error('document should have contained a document/object definition, but instead parsed as type "' + (typeof doc) + '"');
				}
				catch(e) {
					err = new Error('Error parsing ' + ext + ' document ' + filename + ': ' + e);
				}
			}

			if(err) {
				log('error', err);
				if(callback)
					process.nextTick(function() { callback(err, null); });
				return;
			}

			addToDocs(doc);

			if(callback)
				process.nextTick(function() { callback(null, doc); });
		});
	}

	function processVersatileDocument(filename, defaultKey, defaultContentType, callback) {

		fs.readFile(filename, 'utf8', function onReadfileComplete(err, text) {
			if(err) {
				log('error', err);
				if(callback)
					process.nextTick(function() { callback(err, null); });
				return;
			}

			var extraDocProperties = {
				filename: filename
			};

			var doc = parseDocumentText(text, defaultKey, defaultContentType, extraDocProperties);
			addToDocs(doc);

			if(callback)
				process.nextTick(function() { callback(null, doc); });
		});
	}

	function parseDocumentText(text, defaultKey, defaultContentType, extraDocProperties) {
		var parsedKey = parseKey(defaultKey || 'content') || { key:'content', filters:[] };
		var docContext = {
			lines:   text.split(/\n/g),
			doc:     {
						contentType: defaultContentType
					 },
			current: {
						key:     parsedKey.key,
						filters: parsedKey.filters,
						lines:   []
					 }
		};
		if(extraDocProperties)
			_.extend(docContext.doc, extraDocProperties);

		buildDoc(docContext);
		return docContext.doc;
	}

	function renderProperty(layout, key, contextDoc) {
		if(layout[key] && layout[key].renderer && typeof layout[key].renderer === 'function') {
			var t = layout[key].renderer(contextDoc || layout);
			return t;
		}
		return contextDoc && contextDoc[key] ? contextDoc[key] : layout[key];
	}

	var contextDocStack = [];
	function mergeDocIntoLayout(doc, layout) {
		var basedoc = _.extend({}, doc);
		delete basedoc.layout;
		var newdoc = _.extend({}, layout, basedoc);

		if(module.exports.contextDoc)
			contextDocStack.push(module.exports.contextDoc);
		module.exports.contextDoc = newdoc;
		_.each(_.keys(newdoc), function onNewdocKey(key) {
			newdoc[key] = renderProperty(layout, key, newdoc);
		});
		module.exports.contextDoc = contextDocStack.pop() || null;

		return newdoc;
	}

	function mergeDocTree(requestedDoc, contextData) {
		var outputDoc = _.extend({}, requestedDoc, contextData || {});
		var usedLayouts = [];

		outputDoc = mergeDocIntoLayout({}, outputDoc);
		while(outputDoc.layout) {
			
			if(usedLayouts[outputDoc.layout])
				return { error: 'Unable to render document: layout "' + outputDoc.layout + '" usage is recursive' };
			usedLayouts[outputDoc.layout] = true;
			
			var layoutDoc = docs[outputDoc.layout];
			if(layoutDoc === undefined)
				return { error: 'Unable to render document: layout "' + outputDoc.layout + '" not found' };
			
			outputDoc = mergeDocIntoLayout(outputDoc, layoutDoc);
		}

		return outputDoc;
	};

	function readDir(path, callback) {
		var paths = [];
		Q.ncall(fs.readdir, fs, path).then(function onReaddirComplete(files) {
			var promises = _.map(files, function onMapFilenames(name) { return Q.ncall(fs.stat, fs, path + '/' + name); });
			Q.all(promises).then(function onStatsReturned(stats) {
				var promises2 = [];
				for(var i = 0; i < files.length; i++) {
					var subpath = path + '/' + files[i];
					if(stats[i].isFile()) {
						paths.push(subpath);
					}
					else if(stats[i].isDirectory())
						promises2.push(Q.ncall(readDir, null, subpath));
				}
				Q.all(promises2).then(function onPathsGathered(filenames) {
					_.each(filenames, function onPromisesComplete(f) {
						_.each(f, function onEachReturnedFilename(filename) {
							paths.push(filename);
						});
					});
					process.nextTick(function onNextTick() { callback(null, paths); });
				}).end();
			}).end();
		}).end();
	}

	var versatile = module.exports = {

		addFilter: function addFilter(id, filter) {
			filters[id] = filter;
			filters.push(filter);
		},

		setFileType: function setFileTypeDefaults(fileExtension, defaults) {
			fileTypes[fileExtension] = defaults;
		},

		loadContent: function loadContent(contentPath, callback) {

			readDir(contentPath, function onReadDirComplete(err, paths) {
				var promises = [];
				_.each(paths, function onEachFilename(path) {
					var ext = path.substr(path.lastIndexOf('.'));
					if(ext == '.json' || ext == '.js')
						promises.push(Q.ncall(processJsDocument, null, path, ext));
					else {
						var defaults = fileTypes[ext];
						if(defaults === undefined) return;
						promises.push(Q.ncall(processVersatileDocument, null, path, defaults.key, defaults.contentType));
					}
				});
				if(callback)
					Q.all(promises).then(function onAllDocumentsProcessed(arr) {
						process.nextTick(callback);
					}).end();
			});

			this.docs = docs;
		},

		buildResponseDocument: function buildResponseDocument(arg, contextDoc) {
			var doc = typeof arg === 'string' ? docs[arg] : arg;
			if(doc === undefined || !doc)
				return null;
			if(typeof doc !== 'object')
				throw new Error('The specified document was of the wrong type (expected "object" but was "' + (typeof doc) + '")');
			var d = mergeDocTree(doc, contextDoc);
			return d;
		},

		log: function defaultLogger(type, msg) {
			console.log(msg);
		},

		contextDoc: null
	}

	// --- Default Filters -----------------------------------------------------

	versatile.addFilter('html', function filterHtml(value) {
		return value;
	});

	versatile.addFilter('int', function filterInt(value) {
		return parseInt(value);
	});

	versatile.addFilter('float', function filterFloat(value) {
		return parseFloat(value);
	});

	versatile.addFilter('bool', function filterBool(value) {
		return value === 'true';
	});

	// the specified document's properties will be copied into the active
	// document, except for the "content" property, which will be returned
	// to become the value of the property referencing this mixin
	versatile.addFilter('mixin', function filterMixin(value, doc, key) {
		return {
			renderer: function onMixinRenderer(doc) {
				var mixinDoc = versatile.docs[value];
				//return JSON.stringify(mixinDoc);
				if(!mixinDoc)
					return 'No document found with id "' + value + '"';
				mixinDoc = versatile.buildResponseDocument(mixinDoc);

				var returnVal;
				_.each(_.keys(mixinDoc), function onMixinDocKey(mixinKey) {
					var val = mixinDoc[mixinKey];
					if(val && val.renderer && typeof val.renderer == 'function')
						val = val.renderer(mixinDoc);
					if(mixinKey == 'content')
						returnVal = val;
					else
						doc[mixinKey] = val;
				});
				return returnVal || mixinDoc;
			}
		};
	});

	// the specified document content (if it returns a renderer function) will
	// be rendered in the context of the containing document at run-time. the
	// containing doc's id, layout and any renderer values will not be passed in.
	versatile.addFilter('partial', function filterPartial(value, doc, key) {
		return {
			renderer: function onPartialRenderer(doc) {
				var partialDoc = versatile.docs[value];
				if(!partialDoc)
					return 'No document found with id "' + value + '"';
				
				doc = _.extend({}, doc);
				delete doc[key];
				_.each(_.keys(doc), function onPartialKey(key) {
					if(doc[key] && typeof doc[key].renderer == 'function')
						delete doc[key];
				});
				delete doc.layout;
				delete doc.id;

				var outputDoc = versatile.buildResponseDocument(partialDoc, doc);
				return outputDoc.content || outputDoc;
			}
		};
	});

	// the specified document will be pre-rendered independantly, then the
	// resultant content embedded statitically into the unrendered document
	versatile.addFilter('embed', function filterEmbed(value) {
		return {
			renderer: function onEmbedRenderer(doc) {
				var embedDoc = versatile.docs[value];
				if(!embedDoc)
					return 'No document found with id "' + value + '"';
				
				var outputDoc = versatile.buildResponseDocument(embedDoc);
				return outputDoc.content || outputDoc;
			}
		}
	});

	// --- Default File Types --------------------------------------------------

	versatile.setFileType('.txt', {
		key:         'content',
		contentType: 'text/plain'
	});

	versatile.setFileType('.html', {
		key:         'content:html',
		contentType: 'text/html'
	});

})();
