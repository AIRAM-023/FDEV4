/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MainContext, MainThreadWebviewsShape, IMainContext, ExtHostWebviewsShape, WebviewPanelHandle } from './extHost.protocol';
import * as vscode from 'vscode';
import { Event, Emitter } from 'vs/base/common/event';
import * as typeConverters from 'vs/workbench/api/node/extHostTypeConverters';
import { Position } from 'vs/platform/editor/common/editor';
import { TPromise } from 'vs/base/common/winjs.base';
import { Disposable } from './extHostTypes';

export class ExtHostWebview implements vscode.Webview {
	private readonly _handle: WebviewPanelHandle;
	private readonly _proxy: MainThreadWebviewsShape;
	private _title: string;
	private _html: string;
	private _options: vscode.WebviewOptions;
	private _isDisposed: boolean = false;

	public readonly onDisposeEmitter = new Emitter<void>();
	public readonly onDidDispose: Event<void> = this.onDisposeEmitter.event;

	public readonly onMessageEmitter = new Emitter<any>();
	public readonly onDidReceiveMessage: Event<any> = this.onMessageEmitter.event;

	constructor(
		handle: WebviewPanelHandle,
		proxy: MainThreadWebviewsShape,
		title: string,
		options: vscode.WebviewOptions
	) {
		this._handle = handle;
		this._proxy = proxy;
		this._title = title;
		this._options = options;
	}

	public dispose() {
		if (this._isDisposed) {
			return;
		}

		this._isDisposed = true;
		this.onDisposeEmitter.fire();

		this._proxy.$disposeWebview(this._handle);

		this.onDisposeEmitter.dispose();
	}

	get title(): string {
		this.assertNotDisposed();
		return this._title;
	}

	set title(value: string) {
		this.assertNotDisposed();
		if (this._title !== value) {
			this._title = value;
			this._proxy.$setTitle(this._handle, value);
		}
	}

	get html(): string {
		this.assertNotDisposed();
		return this._html;
	}

	set html(value: string) {
		this.assertNotDisposed();
		if (this._html !== value) {
			this._html = value;
			this._proxy.$setHtml(this._handle, value);
		}
	}

	get options(): vscode.WebviewOptions {
		this.assertNotDisposed();
		return this._options;
	}

	public postMessage(message: any): Thenable<boolean> {
		this.assertNotDisposed();
		return this._proxy.$postMessage(this._handle, message);
	}

	public reveal(viewColumn: vscode.ViewColumn): void {
		this.assertNotDisposed();
		this._proxy.$reveal(this._handle, typeConverters.fromViewColumn(viewColumn));
	}

	private assertNotDisposed() {
		if (this._isDisposed) {
			throw new Error('Webview is disposed');
		}
	}
}

export class ExtHostWebviewPanel implements vscode.WebviewPanel {

	private readonly _handle: WebviewPanelHandle;
	private readonly _proxy: MainThreadWebviewsShape;
	private readonly _viewType: string;
	private readonly _options: vscode.WebviewPanelOptions;
	private readonly _webview: ExtHostWebview;
	private _isDisposed: boolean = false;
	private _viewColumn: vscode.ViewColumn;
	private _visible: boolean = true;

	public readonly onDidChangeViewStateEmitter = new Emitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
	public readonly onDidChangeViewState: Event<vscode.WebviewPanelOnDidChangeViewStateEvent> = this.onDidChangeViewStateEmitter.event;

	constructor(
		handle: WebviewPanelHandle,
		proxy: MainThreadWebviewsShape,
		viewType: string,
		viewColumn: vscode.ViewColumn,
		editorOptions: vscode.WebviewPanelOptions,
		webview: ExtHostWebview
	) {
		this._handle = handle;
		this._proxy = proxy;
		this._viewType = viewType;
		this._options = editorOptions;
		this._viewColumn = viewColumn;
		this._webview = webview;

		webview.onDidDispose(this.dispose, this);
	}

	public dispose() {
		if (this._isDisposed) {
			return;
		}

		this._isDisposed = true;
		this.onDidChangeViewStateEmitter.dispose();
	}

	public get webview() {
		return this._webview;
	}

	public get viewType(): string {
		return this._viewType;
	}

	public get options() {
		return this._options;
	}

	public get viewColumn(): vscode.ViewColumn | undefined {
		return this._isDisposed ? undefined : this._viewColumn;
	}

	_setViewColumn(value: vscode.ViewColumn) {
		this.assertNotDisposed();
		this._viewColumn = value;
	}

	public get visible(): boolean {
		return !this._isDisposed && this._visible;
	}

	_setVisible(value: boolean) {
		this.assertNotDisposed();
		this._visible = value;
	}

	public postMessage(message: any): Thenable<boolean> {
		this.assertNotDisposed();
		return this._proxy.$postMessage(this._handle, message);
	}

	public reveal(viewColumn: vscode.ViewColumn): void {
		this.assertNotDisposed();
		this._proxy.$reveal(this._handle, typeConverters.fromViewColumn(viewColumn));
	}

	private assertNotDisposed() {
		if (this._isDisposed) {
			throw new Error('Webview is disposed');
		}
	}
}

export class ExtHostWebviews implements ExtHostWebviewsShape {
	private static webviewHandlePool = 1;

	private readonly _proxy: MainThreadWebviewsShape;

	private readonly _webviewPanels = new Map<WebviewPanelHandle, ExtHostWebviewPanel>();
	private readonly _serializers = new Map<string, vscode.WebviewPanelSerializer>();

	constructor(
		mainContext: IMainContext
	) {
		this._proxy = mainContext.getProxy(MainContext.MainThreadWebviews);
	}

	createWebview(
		viewType: string,
		title: string,
		viewColumn: vscode.ViewColumn,
		options: vscode.WebviewPanelOptions & vscode.WebviewOptions,
		extensionFolderPath: string
	): vscode.WebviewPanel {
		const handle = ExtHostWebviews.webviewHandlePool++ + '';
		this._proxy.$createWebviewPanel(handle, viewType, title, typeConverters.fromViewColumn(viewColumn), options, extensionFolderPath);

		const webview = new ExtHostWebview(handle, this._proxy, title, options);
		const panel = new ExtHostWebviewPanel(handle, this._proxy, viewType, viewColumn, options, webview);
		this._webviewPanels.set(handle, panel);
		return panel;
	}

	registerWebviewPanelSerializer(
		viewType: string,
		serializer: vscode.WebviewPanelSerializer
	): vscode.Disposable {
		if (this._serializers.has(viewType)) {
			throw new Error(`Serializer for '${viewType}' already registered`);
		}

		this._serializers.set(viewType, serializer);
		this._proxy.$registerSerializer(viewType);

		return new Disposable(() => {
			this._serializers.delete(viewType);
			this._proxy.$unregisterSerializer(viewType);
		});
	}

	$onMessage(handle: WebviewPanelHandle, message: any): void {
		const panel = this.getWebviewPanel(handle);
		if (panel) {
			panel.webview.onMessageEmitter.fire(message);
		}
	}

	$onDidChangeWebviewPanelViewState(handle: WebviewPanelHandle, visible: boolean, position: Position): void {
		const panel = this.getWebviewPanel(handle);
		if (panel) {
			const viewColumn = typeConverters.toViewColumn(position);
			if (panel.visible !== visible || panel.viewColumn !== viewColumn) {
				panel._setVisible(visible);
				panel._setViewColumn(viewColumn);
				panel.onDidChangeViewStateEmitter.fire({ webviewPanel: panel });
			}
		}
	}

	$onDidDisposeWebviewPanel(handle: WebviewPanelHandle): Thenable<void> {
		const panel = this.getWebviewPanel(handle);
		if (panel) {
			panel.webview.dispose();
			this._webviewPanels.delete(handle);
		}
		return TPromise.as(void 0);
	}

	$deserializeWebviewPanel(
		webviewHandle: WebviewPanelHandle,
		viewType: string,
		title: string,
		state: any,
		position: Position,
		options: vscode.WebviewOptions & vscode.WebviewPanelOptions
	): Thenable<void> {
		const serializer = this._serializers.get(viewType);
		if (!serializer) {
			return TPromise.wrapError(new Error(`No serializer found for '${viewType}'`));
		}

		const webview = new ExtHostWebview(webviewHandle, this._proxy, title, options);
		const revivedPanel = new ExtHostWebviewPanel(webviewHandle, this._proxy, viewType, typeConverters.toViewColumn(position), options, webview);
		this._webviewPanels.set(webviewHandle, revivedPanel);
		return serializer.deserializeWebviewPanel(revivedPanel, state);
	}

	$serializeWebviewPanel(
		webviewHandle: WebviewPanelHandle
	): Thenable<any> {
		const panel = this.getWebviewPanel(webviewHandle);
		if (!panel) {
			return TPromise.as(undefined);
		}

		const serialzer = this._serializers.get(panel.viewType);
		if (!serialzer) {
			return TPromise.as(undefined);
		}

		return serialzer.serializeWebviewPanel(panel);
	}

	private getWebviewPanel(handle: WebviewPanelHandle): ExtHostWebviewPanel | undefined {
		return this._webviewPanels.get(handle);
	}
}