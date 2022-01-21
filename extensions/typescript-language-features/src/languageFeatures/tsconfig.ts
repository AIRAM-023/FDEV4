/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as jsonc from 'jsonc-parser';
import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import { basename, dirname, join, posix } from 'path';
import { coalesce, flatten } from '../utils/arrays';
import { exists } from '../utils/fs';
import { Utils } from 'vscode-uri';

function mapChildren<R>(node: jsonc.Node | undefined, f: (x: jsonc.Node) => R): R[] {
	return node && node.type === 'array' && node.children
		? node.children.map(f)
		: [];
}

const openExtendsLinkCommandId = '_typescript.openExtendsLink';
type OpenExtendsLinkCommandArgs = {
	resourceUri: vscode.Uri
	extendsValue: string
};

const localize = nls.loadMessageBundle();

class TsconfigLinkProvider implements vscode.DocumentLinkProvider {

	public provideDocumentLinks(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken
	): vscode.DocumentLink[] {
		const root = jsonc.parseTree(document.getText());
		if (!root) {
			return [];
		}

		return coalesce([
			this.getExtendsLink(document, root),
			...this.getFilesLinks(document, root),
			...this.getReferencesLinks(document, root)
		]);
	}

	private getExtendsLink(document: vscode.TextDocument, root: jsonc.Node): vscode.DocumentLink | undefined {
		const extendsNode = jsonc.findNodeAtLocation(root, ['extends']);
		if (!this.isPathValue(extendsNode)) {
			return undefined;
		}

		const args: OpenExtendsLinkCommandArgs = {
			resourceUri: document.uri,
			extendsValue: extendsNode.value
		};

		return new vscode.DocumentLink(
			this.getRange(document, extendsNode),
			vscode.Uri.parse(`command:${openExtendsLinkCommandId}?${JSON.stringify(args)}`)
		);
	}

	private getFilesLinks(document: vscode.TextDocument, root: jsonc.Node) {
		return mapChildren(
			jsonc.findNodeAtLocation(root, ['files']),
			child => this.pathNodeToLink(document, child));
	}

	private getReferencesLinks(document: vscode.TextDocument, root: jsonc.Node) {
		return mapChildren(
			jsonc.findNodeAtLocation(root, ['references']),
			child => {
				const pathNode = jsonc.findNodeAtLocation(child, ['path']);
				if (!this.isPathValue(pathNode)) {
					return undefined;
				}

				return new vscode.DocumentLink(this.getRange(document, pathNode),
					basename(pathNode.value).endsWith('.json')
						? this.getFileTarget(document, pathNode)
						: this.getFolderTarget(document, pathNode));
			});
	}

	private pathNodeToLink(
		document: vscode.TextDocument,
		node: jsonc.Node | undefined
	): vscode.DocumentLink | undefined {
		return this.isPathValue(node)
			? new vscode.DocumentLink(this.getRange(document, node), this.getFileTarget(document, node))
			: undefined;
	}

	private isPathValue(extendsNode: jsonc.Node | undefined): extendsNode is jsonc.Node {
		return extendsNode
			&& extendsNode.type === 'string'
			&& extendsNode.value
			&& !(extendsNode.value as string).includes('*'); // don't treat globs as links.
	}

	private getFileTarget(document: vscode.TextDocument, node: jsonc.Node): vscode.Uri {
		return vscode.Uri.file(join(dirname(document.uri.fsPath), node.value));
	}

	private getFolderTarget(document: vscode.TextDocument, node: jsonc.Node): vscode.Uri {
		return vscode.Uri.file(join(dirname(document.uri.fsPath), node.value, 'tsconfig.json'));
	}

	private getRange(document: vscode.TextDocument, node: jsonc.Node) {
		const offset = node.offset;
		const start = document.positionAt(offset + 1);
		const end = document.positionAt(offset + (node.length - 1));
		return new vscode.Range(start, end);
	}
}

// Reference: https://github.com/microsoft/TypeScript/blob/febfd442cdba343771f478cf433b0892f213ad2f/src/compiler/commandLineParser.ts#L3005
/**
 * @returns Returns undefined in case of lack of result while trying to resolve from node_modules
 */
const getTsconfigPath = async (baseDirUri: vscode.Uri, extendsValue: string): Promise<vscode.Uri | undefined> => {
	// Don't take into account a case, where tsconfig might be resolved from the root (see the reference)
	// e.g. C:/projects/shared-tsconfig/tsconfig.json (note that C: prefix is optional)

	const isRelativePath = ['./', '../'].some(str => extendsValue.startsWith(str));
	if (isRelativePath) {
		const absolutePath = vscode.Uri.joinPath(baseDirUri, extendsValue);
		if (await exists(absolutePath)) { return absolutePath; }
		// Will suggest to create a .json variant if it doesn't exist yet
		return absolutePath.with({
			path: `${absolutePath.path}.json`
		});
	}

	// Otherwise resolve like a module
	return resolveNodeModulesPath([
		extendsValue,
		`${extendsValue}.json`,
		`${extendsValue}/tsconfig.json`,
	]);

	async function resolveNodeModulesPath(pathCandidates: string[]): Promise<vscode.Uri | undefined> {
		let currentUri = baseDirUri;
		while (true) {
			const nodeModulesUri = vscode.Uri.joinPath(currentUri, 'node_modules');
			let nodeModulesStat: vscode.FileStat | undefined;
			try {
				nodeModulesStat = await vscode.workspace.fs.stat(nodeModulesUri);
			} catch (err) { }
			if (nodeModulesStat && (nodeModulesStat.type & vscode.FileType.Directory)) {
				for (const uriCandidate of pathCandidates.map((relativePath) => vscode.Uri.joinPath(nodeModulesUri, relativePath))) {
					if (await exists(uriCandidate)) {
						return uriCandidate;
					}
				}
			}
			// reached the root
			if (posix.relative(currentUri.path, '/') === '') { return; }

			currentUri = vscode.Uri.joinPath(currentUri, '..');
		}

	}
};

export function register() {
	const patterns: vscode.GlobPattern[] = [
		'**/[jt]sconfig.json',
		'**/[jt]sconfig.*.json',
	];

	const languages = ['json', 'jsonc'];

	const selector: vscode.DocumentSelector = flatten(
		languages.map(language =>
			patterns.map((pattern): vscode.DocumentFilter => ({ language, pattern }))));

	return vscode.Disposable.from(
		vscode.commands.registerCommand(openExtendsLinkCommandId, async ({ resourceUri, extendsValue, }: OpenExtendsLinkCommandArgs) => {
			const tsconfigPath = await getTsconfigPath(Utils.dirname(resourceUri), extendsValue);
			if (tsconfigPath === undefined) {
				vscode.window.showErrorMessage(localize('openTsconfigExtendsModuleFail', "Failed to resolve {0} as module", extendsValue));
				return;
			}
			await vscode.workspace.openTextDocument(tsconfigPath);
		}),
		vscode.languages.registerDocumentLinkProvider(selector, new TsconfigLinkProvider()),
	);
}
