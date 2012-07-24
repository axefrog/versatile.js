(function() {

	var fs = require('fs');
	var _ = require('underscore');
	var Q = require('q');
	var filters = [];

	var fileTypes = {};
	var docs = [];

	function trim(s) {
		return (s || '').replace(/^\s*(.*?)\s*$/, '$1');
	}

	function removeTrailingEmptyLines(lines) {
		while(lines && lines.length && !_.last(lines))
			lines.pop();
	}

	function filterValue(value, filters, doc) {
		for(var i in filters)
			value = filters[i](value, doc);
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
			doc[val.key] = filterValue(val.lines.join('\n'), val.filters, doc);
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
					ctx.doc[parsedLine.key] = filterValue(trim(parsedLine.text), parsedLine.filters || []);
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

	function processVersatileDocument(filename, defaultKey, defaultContentType, callback) {

		fs.readFile(filename, 'utf8', function onReadfileComplete(err, text) {
			console.log('processing content file: ' + filename);
			if(err) {
				console.log(err);
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

	function renderContent(doc, contextDoc) {
		if(doc.content.template && typeof doc.content.template === 'function')
			return doc.content.template(contextDoc || doc);
		return doc.content;
	}

	function mergeDocIntoLayout(doc, layout) {
		var basedoc = _.extend({}, doc);
		delete basedoc.layout;
		var newdoc = _.extend({}, layout, basedoc);
		module.exports.contextDoc = newdoc;
		if(layout.content) {
			newdoc.content = renderContent(layout, newdoc);
		}
		module.exports.contextDoc = null;
		return newdoc;
	}

	function mergeDocTree(basedoc) {
		var doc = _.extend({}, basedoc);
		var usedLayouts = [];
		while(doc.layout) {
			if(usedLayouts[doc.layout])
				return { error: 'Unable to render document: layout "' + doc.layout + '" usage is recursive' };
			usedLayouts[doc.layout] = true;
			var layoutDoc = docs[doc.layout];
			if(layoutDoc === undefined)
				return { error: 'Unable to render document: layout "' + doc.layout + '" not found' };
			if(doc.content)
				doc.content = renderContent(doc);
			doc = mergeDocIntoLayout(doc, layoutDoc);
		}
		return doc;
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

		loadContent: function loadContent(callback) {

			readDir('./website/content', function onReadDirComplete(err, paths) {
				var promises = [];
				_.each(paths, function onEachFilename(path) {
					var ext = path.substr(path.lastIndexOf('.'));
					var defaults = fileTypes[ext];
					if(defaults === undefined) return;
					promises.push(Q.ncall(processVersatileDocument, null, path, defaults.key, defaults.contentType));
				});
				if(callback)
					Q.all(promises).then(function(arr) {
						process.nextTick(callback);
					});
			});

			this.docs = docs;
		},

		buildResponseDocument: function buildResponseDocument(arg) {
			var doc = typeof arg === 'string' ? docs[id] : arg;
			if(doc === undefined || !doc)
				return { error: 'The requested document was not found', statusCode: 404 };
			if(typeof doc !== 'object')
				return { error: 'The specified document was of the wrong type (expected "object" but was "' + (typeof doc) + '")' };
			return mergeDocTree(doc);
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

	versatile.addFilter('partial', function filterPartial(value) {
		var doc = versatile.docs[value];
		if(!doc)
			return 'No partial found with id "' + value + '"';
		doc = versatile.buildResponseDocument(doc);
		var content = doc.content;
		if(typeof content === 'function')
			return content(doc);
		return 'No content specified for partial with id "' + value + '"'
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