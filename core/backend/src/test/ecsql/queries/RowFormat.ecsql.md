Copyright © Bentley Systems, Incorporated. All rights reserved. See [LICENSE.md](../../../../LICENSE.md) for license terms and full copyright notice.

# Select ECDb schemas from ECDbMeta using tables but using ECSqlPropertyIndexes

- mode: Statement
- dataset: AllProperties.bim

```sql
Select s.Name, s.Alias from meta.ECSchemaDef s WHERE s.Name LIKE 'ECDb%' LIMIT 4;
```

- rowFormat: ECSqlIndexes

| name  | type   |
| ----- | ------ |
| Name  | String |
| Alias | String |

|                    |         |
| ------------------ | ------- |
| ECDbFileInfo       | ecdbf   |
| ECDbMap            | ecdbmap |
| ECDbMeta           | meta    |
| ECDbSchemaPolicies | ecdbpol |

# Select ECDb schemas from ECDbMeta using tables but using ECSqlPropertyIndexes and testing only one column in expected Results

- mode: Statement
- dataset: AllProperties.bim
- indexesToInclude: [1]

```sql
Select s.Name, s.Alias from meta.ECSchemaDef s WHERE s.Name LIKE 'ECDb%' LIMIT 4;
```

- rowFormat: ECSqlIndexes

| name  | type   |
| ----- | ------ |
| Name  | String |
| Alias | String |

|         |
| ------- |
| ecdbf   |
| ecdbmap |
| meta    |
| ecdbpol |

# Select Test elements from sample dataset using Json using ECSqlPropertyIndexes row option

- dataset: AllProperties.bim

```sql
SELECT e.ECClassId, e.DirectStr FROM aps.TestElement e WHERE e.DirectLong > 1005 ORDER BY e.DirectLong LIMIT 2
```

- rowFormat: ECSqlIndexes

```json
{
  "columns": [
    {
      "accessString": "ECClassId",
      "name": "ECClassId",
      "type": "Id",
      "typeName": "long",
      "generated": false,
      "extendedType": "ClassId"
    },
    {
      "accessString": "DirectStr",
      "name": "DirectStr",
      "type": "String",
      "typeName": "string",
      "generated": false
    }
  ]
}
```

```json
[
  ["0x153", "str6"],
  ["0x153", "str7"]
]
```

# Select Test elements from sample dataset using Json using ECSqlPropertyIndexes row option and testing only one column in expected Results

- dataset: AllProperties.bim
- indexesToInclude: [1]

```sql
SELECT e.ECClassId, e.DirectStr FROM aps.TestElement e WHERE e.DirectLong > 1005 ORDER BY e.DirectLong LIMIT 2
```

- rowFormat: ECSqlIndexes

```json
{
  "columns": [
    {
      "accessString": "ECClassId",
      "name": "ECClassId",
      "type": "Id",
      "typeName": "long",
      "generated": false,
      "extendedType": "ClassId"
    },
    {
      "accessString": "DirectStr",
      "name": "DirectStr",
      "type": "String",
      "typeName": "string",
      "generated": false
    }
  ]
}
```

```json
[["str6"], ["str7"]]
```