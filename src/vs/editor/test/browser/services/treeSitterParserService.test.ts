/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from 'vs/base/test/common/utils';
import { TextModelTreeSitter, TreeSitterImporter, TreeSitterParser, TreeSitterTree } from 'vs/editor/browser/services/treeSitter/treeSitterParserService';
import type { Parser } from '@vscode/tree-sitter-wasm';
import { ITextModel } from 'vs/editor/common/model';
import { createTextModel } from 'vs/editor/test/common/testTextModel';
import { timeout } from 'vs/base/common/async';

class MockParser implements Parser {
	static async init(): Promise<void> { }
	delete(): void { }
	parse(input: string | Parser.Input, oldTree?: Parser.Tree, options?: Parser.Options): Parser.Tree {
		return new MockTree();
	}
	getIncludedRanges(): Parser.Range[] {
		return [];
	}
	getTimeoutMicros(): number { return 0; }
	setTimeoutMicros(timeout: number): void { }
	reset(): void { }
	getLanguage(): Parser.Language { return {} as any; }
	setLanguage(): void { }
	getLogger(): Parser.Logger {
		throw new Error('Method not implemented.');
	}
	setLogger(logFunc?: Parser.Logger | false | null): void {
		throw new Error('Method not implemented.');
	}
}

class MockTreeSitterImporter extends TreeSitterImporter {
	public override async getParserClass(): Promise<typeof Parser> {
		return MockParser as any;
	}
}

class MockTree implements Parser.Tree {
	editorLanguage: string = '';
	editorContents: string = '';
	rootNode: Parser.SyntaxNode = {} as any;
	rootNodeWithOffset(offsetBytes: number, offsetExtent: Parser.Point): Parser.SyntaxNode {
		throw new Error('Method not implemented.');
	}
	copy(): Parser.Tree {
		throw new Error('Method not implemented.');
	}
	delete(): void { }
	edit(edit: Parser.Edit): Parser.Tree {
		return this;
	}
	walk(): Parser.TreeCursor {
		throw new Error('Method not implemented.');
	}
	getChangedRanges(other: Parser.Tree): Parser.Range[] {
		throw new Error('Method not implemented.');
	}
	getIncludedRanges(): Parser.Range[] {
		throw new Error('Method not implemented.');
	}
	getEditedRange(other: Parser.Tree): Parser.Range {
		throw new Error('Method not implemented.');
	}
	getLanguage(): Parser.Language {
		throw new Error('Method not implemented.');
	}
}

class MockLanguage implements Parser.Language {
	version: number = 0;
	fieldCount: number = 0;
	stateCount: number = 0;
	nodeTypeCount: number = 0;
	fieldNameForId(fieldId: number): string | null {
		throw new Error('Method not implemented.');
	}
	fieldIdForName(fieldName: string): number | null {
		throw new Error('Method not implemented.');
	}
	idForNodeType(type: string, named: boolean): number {
		throw new Error('Method not implemented.');
	}
	nodeTypeForId(typeId: number): string | null {
		throw new Error('Method not implemented.');
	}
	nodeTypeIsNamed(typeId: number): boolean {
		throw new Error('Method not implemented.');
	}
	nodeTypeIsVisible(typeId: number): boolean {
		throw new Error('Method not implemented.');
	}
	nextState(stateId: number, typeId: number): number {
		throw new Error('Method not implemented.');
	}
	query(source: string): Parser.Query {
		throw new Error('Method not implemented.');
	}
	lookaheadIterator(stateId: number): Parser.LookaheadIterable | null {
		throw new Error('Method not implemented.');
	}
	languageId: string = '';
}



suite('TreeSitterParserService', function () {
	const treeSitterImporter: TreeSitterImporter = new MockTreeSitterImporter();
	setup(function () {
	});

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('TextModelTreeSitter race condition: first language is slow to load', async function () {
		class MockTreeSitterParser extends TreeSitterParser {
			public override async parse(model: ITextModel, treeSitterTree: TreeSitterTree): Promise<Parser.Tree | undefined> {
				return new MockTree();
			}
			public override async getLanguage(languageId: string): Promise<Parser.Language | undefined> {
				if (languageId === 'javascript') {
					await timeout(200);
				}
				const language = new MockLanguage();
				language.languageId = languageId;
				return language;
			}
		}

		const treeSitterParser: TreeSitterParser = store.add(new MockTreeSitterParser(treeSitterImporter, {} as any, {} as any, {} as any));
		const textModel = store.add(createTextModel('console.log("Hello, world!");', 'javascript'));
		const textModelTreeSitter = store.add(new TextModelTreeSitter(textModel, treeSitterParser, treeSitterImporter));
		textModel.setLanguage('typescript');
		await timeout(300);
		assert.strictEqual((textModelTreeSitter.tree?.language as MockLanguage).languageId, 'typescript');
	});

	test('TextModelTreeSitter race condition: earlier parse is much slower than later parse', async function () {
		class MockTreeSitterParser extends TreeSitterParser {
			private _parseCount = 0;
			public override async parse(model: ITextModel, treeSitterTree: TreeSitterTree): Promise<Parser.Tree | undefined> {
				const tree = new MockTree();
				tree.editorContents = model.getValue();
				this._parseCount++;
				if (this._parseCount === 1) {
					await timeout(200);
				}
				return tree;
			}
			public override async getLanguage(languageId: string): Promise<Parser.Language | undefined> {
				return new MockLanguage();
			}
		}

		const treeSitterParser: TreeSitterParser = store.add(new MockTreeSitterParser(treeSitterImporter, {} as any, {} as any, {} as any));
		const textModel = store.add(createTextModel('console.log("Hello, world!");', 'typescript'));
		const textModelTreeSitter = store.add(new TextModelTreeSitter(textModel, treeSitterParser, treeSitterImporter));
		const secondEditorValue = 'console.log("Hi, world!");';
		await timeout(100);
		textModel.setValue(secondEditorValue);
		await timeout(400);
		assert.strictEqual((textModelTreeSitter.tree?.tree as MockTree).editorContents, secondEditorValue);
	});
});
