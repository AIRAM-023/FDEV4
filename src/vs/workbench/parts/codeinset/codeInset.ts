/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerLanguageCommand } from 'vs/editor/browser/editorExtensions';
import { ICodeInsetSymbol, CodeInsetProvider, CodeInsetProviderRegistry } from 'vs/editor/common/modes';
import { ITextModel } from 'vs/editor/common/model';
import { onUnexpectedExternalError, illegalArgument } from 'vs/base/common/errors';
import { mergeSort } from 'vs/base/common/arrays';
import { URI } from 'vs/base/common/uri';
import { IModelService } from 'vs/editor/common/services/modelService';
import { CancellationToken } from 'vs/base/common/cancellation';

export interface ICodeInsetData {
	symbol: ICodeInsetSymbol;
	provider: CodeInsetProvider;
}

export function getCodeInsetData(model: ITextModel, token: CancellationToken): Promise<ICodeInsetData[]> {

	const symbols: ICodeInsetData[] = [];
	const providers = CodeInsetProviderRegistry.ordered(model);

	const promises = providers.map(provider =>
		Promise.resolve(provider.provideCodeInsets(model, token)).then(result => {
			if (Array.isArray(result)) {
				for (let symbol of result) {
					symbols.push({ symbol, provider });
				}
			}
		}).catch(onUnexpectedExternalError));

	return Promise.all(promises).then(() => {

		return mergeSort(symbols, (a, b) => {
			// sort by lineNumber, provider-rank, and column
			if (a.symbol.range.startLineNumber < b.symbol.range.startLineNumber) {
				return -1;
			} else if (a.symbol.range.startLineNumber > b.symbol.range.startLineNumber) {
				return 1;
			} else if (providers.indexOf(a.provider) < providers.indexOf(b.provider)) {
				return -1;
			} else if (providers.indexOf(a.provider) > providers.indexOf(b.provider)) {
				return 1;
			} else if (a.symbol.range.startColumn < b.symbol.range.startColumn) {
				return -1;
			} else if (a.symbol.range.startColumn > b.symbol.range.startColumn) {
				return 1;
			} else {
				return 0;
			}
		});
	});
}

registerLanguageCommand('_executeCodeInsetProvider', function (accessor, args) {
	let { resource, itemResolveCount } = args;
	if (!(resource instanceof URI)) {
		throw illegalArgument();
	}

	const model = accessor.get(IModelService).getModel(resource);
	if (!model) {
		throw illegalArgument();
	}

	const result: ICodeInsetSymbol[] = [];
	return getCodeInsetData(model, CancellationToken.None).then(value => {

		let resolve: Thenable<any>[] = [];

		for (const item of value) {
			if (typeof itemResolveCount === 'undefined' || Boolean(item.symbol.uri)) {
				result.push(item.symbol);
			} else if (itemResolveCount-- > 0) {
				resolve.push(Promise.resolve(item.provider.resolveCodeInset(model, item.symbol, CancellationToken.None))
					.then(symbol => result.push(symbol)));
			}
		}

		return Promise.all(resolve);

	}).then(() => {
		return result;
	});
});
