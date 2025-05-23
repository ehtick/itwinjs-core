/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module Metadata
 */

import { ECSpecVersion, SchemaReadHelper } from "../Deserialization/Helper";
import { EnumerationProps, EnumeratorProps } from "../Deserialization/JsonProps";
import { PrimitiveType, primitiveTypeToString, SchemaItemType } from "../ECObjects";
import { ECSchemaError, ECSchemaStatus } from "../Exception";
import { ECName } from "../ECName";
import { Schema } from "./Schema";
import { SchemaItem } from "./SchemaItem";

/** @public @preview */
export interface Enumerator<T> {
  readonly name: string;
  readonly value: T;
  readonly label?: string;
  readonly description?: string;
}

/** @public @preview */
export type AnyEnumerator = Enumerator<string | number>;

/**
 * A Typescript class representation of an ECEnumeration.
 * @public @preview
 */
export class Enumeration extends SchemaItem {
  public override readonly schemaItemType = Enumeration.schemaItemType;
  /** @internal */
  public static override get schemaItemType() { return SchemaItemType.Enumeration; }
  private _type?: PrimitiveType.Integer | PrimitiveType.String;
  private _isStrict: boolean;
  private _enumerators: AnyEnumerator[];

  public get enumerators(): ReadonlyArray<AnyEnumerator> { return this._enumerators; }
  public get type() { return this._type; }
  public get isStrict() { return this._isStrict; }

  /** @internal */
  constructor(schema: Schema, name: string, primitiveType?: PrimitiveType.Integer | PrimitiveType.String) {
    super(schema, name);
    this._type = primitiveType;
    this._isStrict = true;
    this._enumerators = [];
  }

  public get isInt(): boolean { return this._type === PrimitiveType.Integer; }
  public get isString(): boolean { return this._type === PrimitiveType.String; }

  /**
   * Gets an enumerator that matches the name provided.
   * @param name The ECName of the Enumerator to find.
   */
  public getEnumeratorByName(name: string): AnyEnumerator | undefined {
    return this.enumerators.find((item) => item.name.toLowerCase() === name.toLowerCase());
  }

  /**
   * Gets an enumerator that matches the value provided.
   * @param value The value of the Enumerator to find.
   */
  public getEnumerator(value: string): Enumerator<string> | undefined;
  public getEnumerator(value: number): Enumerator<number> | undefined;
  public getEnumerator(value: string | number): AnyEnumerator | undefined {
    return this.enumerators.find((item) => item.value === value);
  }

  /**
   * Checks whether there already exists an enumerator with this name or this value
   * @param name The name of the enumerator we are trying to create
   * @param value The value of the enumerator we are trying to create
   * @internal
   */
  private findDuplicateEnumerators(name: string, value: string | number) {
    this._enumerators.forEach((element: AnyEnumerator) => { // Name and value must be unique within the ECEnumerations
      if (element.name.toLowerCase() === name.toLowerCase())
        throw new ECSchemaError(ECSchemaStatus.InvalidECJson, `The Enumeration ${this.name} has a duplicate Enumerator with name '${name}'.`);
      if (element.value === value)
        throw new ECSchemaError(ECSchemaStatus.InvalidECJson, `The Enumeration ${this.name} has a duplicate Enumerator with value '${value}'.`);
    });
  }

  /**
   * Creates an Enumerator with the provided name and value as well as optional parameters label and description
   * @param name The name of the enumerator
   * @param value The value of the enumerator. The type of this value is dependent on the backing type of the this Enumeration.
   * @param label A localized display label that is used instead of the name in a GUI.
   * @param description A localized description for the enumerator.
   * @return AnyEnumerator object
   * @internal
   */
  public createEnumerator(name: string, value: string | number, label?: string, description?: string): AnyEnumerator {
    if (this.isInt && typeof (value) === "string") // throws if backing type is int and value is string
      throw new ECSchemaError(ECSchemaStatus.InvalidECJson, `The Enumeration ${this.name} has a backing type 'integer' and an enumerator with value of type 'string'.`);
    if (!this.isInt && typeof (value) === "number") // also throws if backing type is string and value is number
      throw new ECSchemaError(ECSchemaStatus.InvalidECJson, `The Enumeration ${this.name} has a backing type 'string' and an enumerator with value of type 'integer'.`);
    this.findDuplicateEnumerators(name, value); // check for duplicates; throw if there are any
    if (!ECName.validate(name))
      throw new ECSchemaError(ECSchemaStatus.InvalidECName, `The Enumeration ${this.name} has an enumerator with an invalid 'name' attribute. ${name} is not a valid ECName.`);
    return { name, value, label, description };
  }

  /**
   * Adds enumerator to list of enumerators on this Enumeration
   * @param enumerator The enumerator to add
   * @internal
   */
  protected addEnumerator(enumerator: AnyEnumerator) {
    this._enumerators.push(enumerator);
  }

  /**
   * Save this Enumeration's properties to an object for serializing to JSON.
   * @param standalone Serialization includes only this object (as opposed to the full schema).
   * @param includeSchemaVersion Include the Schema's version information in the serialized object.
   */
  public override toJSON(standalone: boolean = false, includeSchemaVersion: boolean = false): EnumerationProps {
    const schemaJson = super.toJSON(standalone, includeSchemaVersion) as any;
    schemaJson.type = (this.isInt) ? "int" : "string";
    schemaJson.isStrict = this.isStrict;
    schemaJson.enumerators = this._enumerators.map(({ name, label, value, description }) => {
      const enumJson: any = { name, value };
      if (undefined !== label)
        enumJson.label = label;
      if (undefined !== description)
        enumJson.description = description;
      return enumJson;
    });
    return schemaJson;
  }

  /** @internal */
  public override async toXml(schemaXml: Document): Promise<Element> {
    const itemElement = await super.toXml(schemaXml);
    if (undefined !== this.type)
      itemElement.setAttribute("backingTypeName", primitiveTypeToString(this.type));
    itemElement.setAttribute("isStrict", String(this.isStrict));

    for (const enumerator of this.enumerators) {
      const enumElement = schemaXml.createElement("ECEnumerator");
      enumElement.setAttribute("name", enumerator.name);
      const enumValue = typeof enumerator.value === "string" ? enumerator.value : enumerator.value.toString();
      enumElement.setAttribute("value", enumValue);
      if (undefined !== enumerator.label)
        enumElement.setAttribute("displayLabel", enumerator.label);
      if (undefined !== enumerator.description)
        enumElement.setAttribute("description", enumerator.description);
      itemElement.appendChild(enumElement);
    }

    return itemElement;
  }

  public override fromJSONSync(enumerationProps: EnumerationProps) {
    super.fromJSONSync(enumerationProps);
    if (undefined === this._type) {
      if (/int/i.test(enumerationProps.type)) {
        this._type = PrimitiveType.Integer;
      } else if (/string/i.test(enumerationProps.type)) {
        this._type = PrimitiveType.String;
      } else {
        if (SchemaReadHelper.isECSpecVersionNewer({ readVersion: enumerationProps.originalECSpecMajorVersion, writeVersion: enumerationProps.originalECSpecMinorVersion } as ECSpecVersion))
          this._type = PrimitiveType.String;
        else
          throw new ECSchemaError(ECSchemaStatus.InvalidECJson, `The Enumeration ${this.name} has an invalid 'type' attribute. It should be either "int" or "string".`);
      }
    } else {
      const primitiveTypePattern = (this.isInt) ? /int/i : /string/i;
      if (!primitiveTypePattern.test(enumerationProps.type))
        throw new ECSchemaError(ECSchemaStatus.InvalidECJson, `The Enumeration ${this.name} has an incompatible type. It must be "${(this.isInt) ? "int" : "string"}", not "${(this.isInt) ? "string" : "int"}".`);
    }
    this._isStrict = enumerationProps.isStrict;

    if (undefined !== enumerationProps.enumerators) {
      enumerationProps.enumerators.forEach((enumerator: EnumeratorProps) => {
        // Creates a new enumerator (with the specified name, value, label and description- label and description are optional) and adds to the list of enumerators.
        // Throws ECSchemaError if there are duplicate names or values present in the enumeration
        this.addEnumerator(this.createEnumerator(enumerator.name, enumerator.value, enumerator.label, enumerator.description));
      });
    }
  }

  public override async fromJSON(enumerationProps: EnumerationProps) {
    this.fromJSONSync(enumerationProps);
  }

  /**
   * @internal
   */
  protected setIsStrict(isStrict: boolean) {
    this._isStrict = isStrict;
  }

  /**
   * Type guard to check if the SchemaItem is of type Enumeration.
   * @param item The SchemaItem to check.
   * @returns True if the item is an Enumeration, false otherwise.
   */
  public static isEnumeration(item?: SchemaItem): item is Enumeration {
    return item?.schemaItemType === SchemaItemType.Enumeration;
  }

  /**
   * Type assertion to check if the SchemaItem is of type Enumeration.
   * @param item The SchemaItem to check.
   * @returns The item cast to Enumeration if it is an Enumeration, undefined otherwise.
   * @internal
   */
  public static assertIsEnumeration(item?: SchemaItem): asserts item is Enumeration {
    if (!this.isEnumeration(item))
      throw new ECSchemaError(ECSchemaStatus.InvalidSchemaItemType, `Expected '${SchemaItemType.Enumeration}' (Enumeration)`);
  }
}

/**
 * An abstract class used for schema editing.
 *
 * @internal
 */
export abstract class MutableEnumeration extends Enumeration {
  public abstract override addEnumerator(enumerator: AnyEnumerator): void;
  public abstract override setIsStrict(isStrict: boolean): void;
  public abstract override setDisplayLabel(displayLabel: string): void;
}
