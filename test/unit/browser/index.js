/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

import path, { join } from 'path';
import glob from 'glob';
import events from 'events';
import mocha from 'mocha';
import createStatsCollector from '../../../node_modules/mocha/lib/stats-collector.js';
import MochaJUnitReporter from 'mocha-junit-reporter';
import url from 'url';
import minimatch from 'minimatch';
import fs from 'fs';
import playwright from 'playwright-core';
import { applyReporter } from '../reporter.js';
import * as yaserver from 'yaserver';
import http from 'http';
import { randomBytes } from 'crypto';
import minimist from 'minimist';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @type {{
 * run: string;
 * grep: string;
 * runGlob: string;
 * browser: string;
 * reporter: string;
 * 'reporter-options': string;
 * tfs: string;
 * build: boolean;
 * debug: boolean;
 * sequential: boolean;
 * help: boolean;
 * }}
*/
const args = minimist(process.argv.slice(2), {
	boolean: ['build', 'debug', 'sequential', 'help'],
	string: ['run', 'grep', 'runGlob', 'browser', 'reporter', 'reporter-options', 'tfs'],
	default: {
		build: false,
		browser: ['chromium', 'firefox', 'webkit'],
		reporter: process.platform === 'win32' ? 'list' : 'spec',
		'reporter-options': ''
	},
	alias: {
		grep: ['g', 'f'],
		runGlob: ['glob', 'runGrep'],
		debug: ['debug-browser'],
		help: 'h'
	},
	describe: {
		build: 'run with build output (out-build)',
		run: 'only run tests matching <relative_file_path>',
		grep: 'only run tests matching <pattern>',
		debug: 'do not run browsers headless',
		sequential: 'only run suites for a single browser at a time',
		browser: 'browsers in which tests should run',
		reporter: 'the mocha reporter',
		'reporter-options': 'the mocha reporter options',
		tfs: 'tfs',
		help: 'show the help'
	}
});

if (args.help) {
	console.log(`Usage: node ${process.argv[1]} [options]

Options:
--build              run with build output (out-build)
--run <relative_file_path> only run tests matching <relative_file_path>
--grep, -g, -f <pattern> only run tests matching <pattern>
--debug, --debug-browser do not run browsers headless
--sequential         only run suites for a single browser at a time
--browser <browser>  browsers in which tests should run
--reporter <reporter> the mocha reporter
--reporter-options <reporter-options> the mocha reporter options
--tfs <tfs>          tfs
--help, -h           show the help`);
	process.exit(0);
}

const withReporter = (function () {
	if (args.tfs) {
		{
			return (browserType, runner) => {
				new mocha.reporters.Spec(runner);
				new MochaJUnitReporter(runner, {
					reporterOptions: {
						testsuitesTitle: `${args.tfs} ${process.platform}`,
						mochaFile: process.env.BUILD_ARTIFACTSTAGINGDIRECTORY ? path.join(process.env.BUILD_ARTIFACTSTAGINGDIRECTORY, `test-results/${process.platform}-${process.arch}-${browserType}-${args.tfs.toLowerCase().replace(/[^\w]/g, '-')}-results.xml`) : undefined
					}
				});
			};
		}
	} else {
		return (_, runner) => applyReporter(runner, args);
	}
})();

const outdir = args.build ? 'out-build' : 'out';
const rootDir = path.resolve(__dirname, '..', '..', '..');
const out = path.join(rootDir, `${outdir}`);

function ensureIsArray(a) {
	return Array.isArray(a) ? a : [a];
}

const testModules = (async function () {

	const excludeGlob = '**/{node,electron-sandbox,electron-main}/**/*.test.js';
	let isDefaultModules = true;
	let promise;

	if (args.run) {
		// use file list (--run)
		isDefaultModules = false;
		promise = Promise.resolve(ensureIsArray(args.run).map(file => {
			file = file.replace(/^src/, 'out');
			file = file.replace(/\.ts$/, '.js');
			return path.relative(out, file);
		}));

	} else {
		// glob patterns (--glob)
		const defaultGlob = '**/*.test.js';
		const pattern = args.runGlob || defaultGlob;
		isDefaultModules = pattern === defaultGlob;

		promise = new Promise((resolve, reject) => {
			glob(pattern, { cwd: out }, (err, files) => {
				if (err) {
					reject(err);
				} else {
					resolve(files);
				}
			});
		});
	}

	const files = await promise
	const modules = [];
	for (const file of files) {
		if (!minimatch(file, excludeGlob)) {
			modules.push(file.replace(/\.js$/, ''));

		} else if (!isDefaultModules) {
			console.warn(`DROPPONG ${file} because it cannot be run inside a browser`);
		}
	}
	const jsModules = modules.map(module => {
		return `../../../${outdir}/${module}.js`
	})
	return jsModules;
})();

function consoleLogFn(msg) {
	const type = msg.type();
	const candidate = console[type];
	if (candidate) {
		return candidate;
	}

	if (type === 'warning') {
		return console.warn;
	}

	return console.log;
}

async function createServer() {
	// Demand a prefix to avoid issues with other services on the
	// machine being able to access the test server.
	const prefix = '/' + randomBytes(16).toString('hex');
	const serveStatic = await yaserver.createServer({ rootDir });

	/** Handles a request for a remote method call, invoking `fn` and returning the result */
	const remoteMethod = async (req, response, fn) => {
		const params = await new Promise((resolve, reject) => {
			const body = [];
			req.on('data', chunk => body.push(chunk));
			req.on('end', () => resolve(JSON.parse(Buffer.concat(body).toString())));
			req.on('error', reject);
		});

		const result = await fn(...params);
		response.writeHead(200, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify(result));
	};

	const server = http.createServer((request, response) => {
		if (!request.url?.startsWith(prefix)) {
			return response.writeHead(404).end();
		}

		// rewrite the URL so the static server can handle the request correctly
		request.url = request.url.slice(prefix.length);

		switch (request.url) {
			case '/remoteMethod/__readFileInTests':
				return remoteMethod(request, response, p => fs.promises.readFile(p, 'utf-8'));
			case '/remoteMethod/__writeFileInTests':
				return remoteMethod(request, response, (p, contents) => fs.promises.writeFile(p, contents));
			case '/remoteMethod/__readDirInTests':
				return remoteMethod(request, response, p => fs.promises.readdir(p));
			case '/remoteMethod/__unlinkInTests':
				return remoteMethod(request, response, p => fs.promises.unlink(p));
			case '/remoteMethod/__mkdirPInTests':
				return remoteMethod(request, response, p => fs.promises.mkdir(p, { recursive: true }));
			default:
				return serveStatic.handle(request, response);
		}
	});

	return new Promise((resolve, reject) => {
		server.listen(0, 'localhost', () => {
			resolve({
				dispose: () => server.close(),
				// @ts-ignore
				url: `http://localhost:${server.address().port}${prefix}`
			});
		});
		server.on('error', reject);
	});
}

async function runTestsInBrowser(testModules, browserType) {
	const server = await createServer();
	const browser = await playwright[browserType].launch({ headless: !Boolean(args.debug), devtools: Boolean(args.debug) });
	const context = await browser.newContext();
	const page = await context.newPage();
	const target = new URL(server.url + '/test/unit/browser/renderer.html');
	target.searchParams.set('baseUrl', url.pathToFileURL(path.join(rootDir, 'src')).toString());
	if (args.build) {
		target.searchParams.set('build', 'true');
	}
	if (process.env.BUILD_ARTIFACTSTAGINGDIRECTORY) {
		target.searchParams.set('ci', 'true');
	}

	const emitter = new events.EventEmitter();
	await page.exposeFunction('mocha_report', (type, data1, data2) => {
		emitter.emit(type, data1, data2);
	});

	await page.goto(target.href);

	page.on('console', async msg => {
		consoleLogFn(msg)(msg.text(), await Promise.all(msg.args().map(async arg => await arg.jsonValue())));
	});

	withReporter(browserType, new EchoRunner(emitter, browserType.toUpperCase()));

	// collection failures for console printing
	const failingModuleIds = [];
	const failingTests = [];
	emitter.on('fail', (test, err) => {
		failingTests.push({ title: test.fullTitle, message: err.message });

		if (err.stack) {
			const regex = /(vs\/.*\.test)\.js/;
			for (const line of String(err.stack).split('\n')) {
				const match = regex.exec(line);
				if (match) {
					failingModuleIds.push(match[1]);
					return;
				}
			}
		}
	});

	try {
		// @ts-expect-error
		await page.evaluate(opts => loadAndRun(opts), {
			modules: testModules,
			grep: args.grep,
		});
	} catch (err) {
		console.error(err);
	}
	server.dispose();
	await browser.close();

	if (failingTests.length > 0) {
		let res = `The followings tests are failing:\n - ${failingTests.map(({ title, message }) => `${title} (reason: ${message})`).join('\n - ')}`;

		if (failingModuleIds.length > 0) {
			res += `\n\nTo DEBUG, open ${browserType.toUpperCase()} and navigate to ${target.href}?${failingModuleIds.map(module => `m=${module}`).join('&')}`;
		}

		return `${res}\n`;
	}
}

class EchoRunner extends events.EventEmitter {

	constructor(event, title = '') {
		super();
		createStatsCollector(this);
		event.on('start', () => this.emit('start'));
		event.on('end', () => this.emit('end'));
		event.on('suite', (suite) => this.emit('suite', EchoRunner.deserializeSuite(suite, title)));
		event.on('suite end', (suite) => this.emit('suite end', EchoRunner.deserializeSuite(suite, title)));
		event.on('test', (test) => this.emit('test', EchoRunner.deserializeRunnable(test)));
		event.on('test end', (test) => this.emit('test end', EchoRunner.deserializeRunnable(test)));
		event.on('hook', (hook) => this.emit('hook', EchoRunner.deserializeRunnable(hook)));
		event.on('hook end', (hook) => this.emit('hook end', EchoRunner.deserializeRunnable(hook)));
		event.on('pass', (test) => this.emit('pass', EchoRunner.deserializeRunnable(test)));
		event.on('fail', (test, err) => this.emit('fail', EchoRunner.deserializeRunnable(test, title), EchoRunner.deserializeError(err)));
		event.on('pending', (test) => this.emit('pending', EchoRunner.deserializeRunnable(test)));
	}

	static deserializeSuite(suite, titleExtra) {
		return {
			root: suite.root,
			suites: suite.suites,
			tests: suite.tests,
			title: titleExtra && suite.title ? `${suite.title} - /${titleExtra}/` : suite.title,
			titlePath: () => suite.titlePath,
			fullTitle: () => suite.fullTitle,
			timeout: () => suite.timeout,
			retries: () => suite.retries,
			slow: () => suite.slow,
			bail: () => suite.bail
		};
	}

	static deserializeRunnable(runnable, titleExtra) {
		return {
			title: runnable.title,
			fullTitle: () => titleExtra && runnable.fullTitle ? `${runnable.fullTitle} - /${titleExtra}/` : runnable.fullTitle,
			titlePath: () => runnable.titlePath,
			async: runnable.async,
			slow: () => runnable.slow,
			speed: runnable.speed,
			duration: runnable.duration,
			currentRetry: () => runnable.currentRetry,
		};
	}

	static deserializeError(err) {
		const inspect = err.inspect;
		err.inspect = () => inspect;
		return err;
	}
}

testModules.then(async modules => {

	// run tests in selected browsers
	const browserTypes = Array.isArray(args.browser)
		? args.browser : [args.browser];

	let messages = [];
	let didFail = false;

	try {
		if (args.sequential) {
			for (const browserType of browserTypes) {
				messages.push(await runTestsInBrowser(modules, browserType));
			}
		} else {
			messages = await Promise.all(browserTypes.map(async browserType => {
				return await runTestsInBrowser(modules, browserType);
			}));
		}
	} catch (err) {
		console.error(err);
		process.exit(1);
	}

	// aftermath
	for (const msg of messages) {
		if (msg) {
			didFail = true;
			console.log(msg);
		}
	}
	process.exit(didFail ? 1 : 0);

}).catch(err => {
	console.error(err);
});
