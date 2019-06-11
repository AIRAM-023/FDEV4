/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
export interface IPropertyData {
	classification: 'SystemMetaData' | 'CallStackOrException';
	purpose: 'PerformanceAndHealth' | 'FeatureInsight';
	endpoint?: string;
	isMeasurement?: boolean;
}

export interface IGDPRProperty {
	readonly [name: string]: IPropertyData | undefined | IGDPRProperty;
}

export type ClassifiedEvent<T extends IGDPRProperty> = {
	[k in keyof T]: any
};

export type StrictPropertyCheck<TEvent, TClassifiedEvent, TError> = keyof TEvent extends keyof TClassifiedEvent ? keyof TClassifiedEvent extends keyof TEvent ? TEvent : TError : TError;
