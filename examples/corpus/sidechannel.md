# Airlock cold-start brief

You write one Airlock program (`.air`). A supervisor runs it for you and
returns a JSON receipt. You have no shell, no repository, and no second
way to reach the world: every effect is one of the actions below.

## Actions

The complete verb surface. Nothing else is callable.

```json
{
  "schemaVersion": "airlock/actions/v1",
  "actions": [
    {
      "name": "file.inspect",
      "node": "Capture",
      "summary": "Capture an identity-safe filesystem inspection."
    },
    {
      "name": "file.read",
      "node": "Capture",
      "summary": "Capture file bytes, text, or JSON."
    },
    {
      "name": "file.list",
      "node": "Capture",
      "summary": "Capture a directory listing."
    },
    {
      "name": "file.glob",
      "node": "Capture",
      "summary": "Capture a glob expansion rooted at an explicit path."
    },
    {
      "name": "file.stat",
      "node": "Capture",
      "summary": "Capture filesystem metadata without following symlinks by default."
    },
    {
      "name": "file.write",
      "node": "Apply",
      "summary": "Apply a held file write from content or an artifact."
    },
    {
      "name": "file.remove",
      "node": "Apply",
      "summary": "Apply a held removal."
    },
    {
      "name": "file.move",
      "node": "Apply",
      "summary": "Apply a managed move."
    },
    {
      "name": "file.copy",
      "node": "Apply",
      "summary": "Apply a managed copy."
    },
    {
      "name": "file.mkdir",
      "node": "Apply",
      "summary": "Apply managed directory creation."
    },
    {
      "name": "process.run",
      "node": "Invoke",
      "summary": "Invoke one structured executable + args contract inside a Cell."
    },
    {
      "name": "http.stage",
      "node": "RequestExternal",
      "summary": "Stage an HTTP intent; it cannot dispatch from this lowering."
    }
  ],
  "definitions": []
}
```

## Action schemas

Six input and evaluator-result schemas in full. The remaining verbs take
the obvious subset of `path`, `source`, `destination`, `parents`, and `realm`.

### process.run

```json
{
  "schemaVersion": "airlock/discovery/v1",
  "action": {
    "name": "process.run",
    "node": "Invoke",
    "summary": "Invoke one structured executable + args contract inside a Cell.",
    "resultSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$defs": {
        "NativeProcessArtifactResult": {
          "anyOf": [
            {
              "type": "object",
              "required": [
                "id",
                "digest",
                "media_type",
                "byte_length",
                "provenance"
              ],
              "properties": {
                "id": {
                  "type": "string"
                },
                "digest": {
                  "type": "string"
                },
                "media_type": {
                  "type": "string"
                },
                "byte_length": {
                  "type": "number"
                },
                "provenance": {
                  "type": "string"
                }
              },
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "type": "object",
      "required": [
        "state",
        "plan_id",
        "process_outcome",
        "exit_code",
        "signal",
        "stdout",
        "stderr",
        "stdout_artifact",
        "stderr_artifact",
        "delta_artifact",
        "recovery",
        "receipts"
      ],
      "properties": {
        "state": {
          "type": "string",
          "enum": [
            "succeeded",
            "failed",
            "partial"
          ]
        },
        "plan_id": {
          "type": "string"
        },
        "process_outcome": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "exited",
                "timed-out",
                "output-limit",
                "cancelled"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "exit_code": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ]
        },
        "signal": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "stdout": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "stderr": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "stdout_artifact": {
          "$ref": "#/$defs/NativeProcessArtifactResult"
        },
        "stderr_artifact": {
          "$ref": "#/$defs/NativeProcessArtifactResult"
        },
        "delta_artifact": {
          "$ref": "#/$defs/NativeProcessArtifactResult"
        },
        "recovery": {
          "type": "array",
          "items": {
            "anyOf": [
              {
                "type": "object",
                "required": [
                  "nodeId",
                  "operation",
                  "recovery",
                  "_tag"
                ],
                "properties": {
                  "nodeId": {
                    "type": "string"
                  },
                  "operation": {
                    "type": "string"
                  },
                  "recovery": {
                    "type": "object",
                    "required": [
                      "id",
                      "target",
                      "phase",
                      "reason",
                      "_tag"
                    ],
                    "properties": {
                      "id": {
                        "type": "string"
                      },
                      "target": {
                        "type": "string"
                      },
                      "phase": {
                        "type": "string",
                        "enum": [
                          "retain",
                          "install",
                          "restore",
                          "undo",
                          "ledger"
                        ]
                      },
                      "recovery": {
                        "type": "object",
                        "required": [
                          "act",
                          "journalState",
                          "rename",
                          "next",
                          "source",
                          "destination",
                          "syncedDirectories",
                          "failedDirectory"
                        ],
                        "properties": {
                          "act": {
                            "type": "string",
                            "enum": [
                              "remove",
                              "overwrite",
                              "displaced"
                            ]
                          },
                          "journalState": {
                            "type": "string",
                            "enum": [
                              "prepared",
                              "held"
                            ]
                          },
                          "rename": {
                            "type": "string",
                            "enum": [
                              "confirmed"
                            ]
                          },
                          "next": {
                            "type": "string",
                            "enum": [
                              "journal-reconciliation-required"
                            ]
                          },
                          "source": {
                            "type": "string"
                          },
                          "destination": {
                            "type": "string"
                          },
                          "syncedDirectories": {
                            "type": "array",
                            "items": {
                              "type": "string"
                            }
                          },
                          "failedDirectory": {
                            "type": "string"
                          }
                        },
                        "additionalProperties": false
                      },
                      "reason": {
                        "type": "string"
                      },
                      "_tag": {
                        "type": "string",
                        "enum": [
                          "HoldRecoveryRequired"
                        ]
                      }
                    },
                    "additionalProperties": false
                  },
                  "_tag": {
                    "type": "string",
                    "enum": [
                      "RuntimeHoldRecoveryEvidence"
                    ]
                  }
                },
                "additionalProperties": false
              },
              {
                "type": "object",
                "required": [
                  "nodeId",
                  "operation",
                  "recovery",
                  "_tag"
                ],
                "properties": {
                  "nodeId": {
                    "type": "string"
                  },
                  "operation": {
                    "type": "string"
                  },
                  "recovery": {
                    "type": "object",
                    "required": [
                      "source",
                      "destination",
                      "install",
                      "reason",
                      "_tag"
                    ],
                    "properties": {
                      "source": {
                        "type": "string"
                      },
                      "destination": {
                        "type": "string"
                      },
                      "install": {
                        "type": "object",
                        "required": [
                          "receipt",
                          "bytes"
                        ],
                        "properties": {
                          "receipt": {
                            "type": "object",
                            "required": [
                              "id",
                              "source",
                              "target",
                              "kind",
                              "previousHeld",
                              "at",
                              "metadata"
                            ],
                            "properties": {
                              "id": {
                                "type": "string"
                              },
                              "source": {
                                "type": "string"
                              },
                              "target": {
                                "type": "string"
                              },
                              "kind": {
                                "type": "string",
                                "enum": [
                                  "file",
                                  "directory"
                                ]
                              },
                              "previousHeld": {
                                "type": "boolean"
                              },
                              "at": {
                                "type": "string",
                                "description": "a string to be decoded into a DateTime.Utc"
                              },
                              "metadata": {
                                "type": "object",
                                "required": [
                                  "device",
                                  "mode",
                                  "bytes"
                                ],
                                "properties": {
                                  "device": {
                                    "type": "number"
                                  },
                                  "inode": {
                                    "type": "number"
                                  },
                                  "mode": {
                                    "type": "number"
                                  },
                                  "bytes": {
                                    "type": "number"
                                  }
                                },
                                "additionalProperties": false
                              }
                            },
                            "additionalProperties": false
                          },
                          "bytes": {
                            "type": "number"
                          }
                        },
                        "additionalProperties": false
                      },
                      "reason": {
                        "type": "string"
                      },
                      "_tag": {
                        "type": "string",
                        "enum": [
                          "NativeMovePartiallyApplied"
                        ]
                      }
                    },
                    "additionalProperties": false
                  },
                  "_tag": {
                    "type": "string",
                    "enum": [
                      "RuntimeMoveRecoveryEvidence"
                    ]
                  }
                },
                "additionalProperties": false
              },
              {
                "type": "object",
                "required": [
                  "nodeId",
                  "operation",
                  "recovery",
                  "_tag"
                ],
                "properties": {
                  "nodeId": {
                    "type": "string"
                  },
                  "operation": {
                    "type": "string"
                  },
                  "recovery": {
                    "type": "object",
                    "required": [
                      "path",
                      "failedDirectory",
                      "installs",
                      "reason",
                      "_tag"
                    ],
                    "properties": {
                      "path": {
                        "type": "string"
                      },
                      "failedDirectory": {
                        "type": "string"
                      },
                      "installs": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "required": [
                            "receipt",
                            "bytes"
                          ],
                          "properties": {
                            "receipt": {
                              "type": "object",
                              "required": [
                                "id",
                                "source",
                                "target",
                                "kind",
                                "previousHeld",
                                "at",
                                "metadata"
                              ],
                              "properties": {
                                "id": {
                                  "type": "string"
                                },
                                "source": {
                                  "type": "string"
                                },
                                "target": {
                                  "type": "string"
                                },
                                "kind": {
                                  "type": "string",
                                  "enum": [
                                    "file",
                                    "directory"
                                  ]
                                },
                                "previousHeld": {
                                  "type": "boolean"
                                },
                                "at": {
                                  "type": "string",
                                  "description": "a string to be decoded into a DateTime.Utc"
                                },
                                "metadata": {
                                  "type": "object",
                                  "required": [
                                    "device",
                                    "mode",
                                    "bytes"
                                  ],
                                  "properties": {
                                    "device": {
                                      "type": "number"
                                    },
                                    "inode": {
                                      "type": "number"
                                    },
                                    "mode": {
                                      "type": "number"
                                    },
                                    "bytes": {
                                      "type": "number"
                                    }
                                  },
                                  "additionalProperties": false
                                }
                              },
                              "additionalProperties": false
                            },
                            "bytes": {
                              "type": "number"
                            }
                          },
                          "additionalProperties": false
                        }
                      },
                      "reason": {
                        "type": "string"
                      },
                      "_tag": {
                        "type": "string",
                        "enum": [
                          "NativeMkdirPartiallyApplied"
                        ]
                      }
                    },
                    "additionalProperties": false
                  },
                  "_tag": {
                    "type": "string",
                    "enum": [
                      "RuntimeMkdirRecoveryEvidence"
                    ]
                  }
                },
                "additionalProperties": false
              },
              {
                "type": "object",
                "required": [
                  "nodeId",
                  "operation",
                  "recovery",
                  "_tag"
                ],
                "properties": {
                  "nodeId": {
                    "type": "string"
                  },
                  "operation": {
                    "type": "string"
                  },
                  "recovery": {
                    "type": "object",
                    "required": [
                      "id",
                      "phase",
                      "status",
                      "emission",
                      "reason",
                      "_tag"
                    ],
                    "properties": {
                      "id": {
                        "type": "string"
                      },
                      "phase": {
                        "type": "string",
                        "enum": [
                          "ledger-after-stage",
                          "ledger-after-commit",
                          "ledger-after-cancel"
                        ]
                      },
                      "status": {
                        "type": "string",
                        "enum": [
                          "staged",
                          "committed",
                          "cancelled"
                        ]
                      },
                      "emission": {
                        "type": "object",
                        "required": [
                          "id",
                          "status",
                          "intent",
                          "request",
                          "stagedAt",
                          "holdUntil"
                        ],
                        "properties": {
                          "id": {
                            "type": "string"
                          },
                          "status": {
                            "type": "string",
                            "enum": [
                              "staged",
                              "committing",
                              "committed",
                              "uncertain",
                              "cancelled"
                            ]
                          },
                          "intent": {
                            "type": "object",
                            "required": [
                              "kind",
                              "method",
                              "endpoint",
                              "headerNames",
                              "bodyBytes"
                            ],
                            "properties": {
                              "kind": {
                                "type": "string",
                                "enum": [
                                  "http"
                                ]
                              },
                              "method": {
                                "type": "string",
                                "enum": [
                                  "GET",
                                  "POST",
                                  "PUT",
                                  "PATCH",
                                  "DELETE"
                                ]
                              },
                              "endpoint": {
                                "type": "string"
                              },
                              "headerNames": {
                                "type": "array",
                                "items": {
                                  "type": "string"
                                }
                              },
                              "bodyBytes": {
                                "type": "number"
                              }
                            },
                            "additionalProperties": false
                          },
                          "request": {
                            "type": "object",
                            "required": [
                              "method",
                              "url",
                              "headers"
                            ],
                            "properties": {
                              "method": {
                                "type": "string",
                                "enum": [
                                  "GET",
                                  "POST",
                                  "PUT",
                                  "PATCH",
                                  "DELETE"
                                ]
                              },
                              "url": {
                                "type": "string"
                              },
                              "headers": {
                                "type": "object",
                                "required": [],
                                "properties": {},
                                "additionalProperties": {
                                  "type": "string"
                                }
                              },
                              "body": {
                                "type": "string"
                              }
                            },
                            "additionalProperties": false
                          },
                          "stagedAt": {
                            "type": "string",
                            "description": "a string to be decoded into a DateTime.Utc"
                          },
                          "holdUntil": {
                            "type": "string",
                            "description": "a string to be decoded into a DateTime.Utc"
                          },
                          "authorization": {
                            "type": "object",
                            "required": [
                              "sealDigest",
                              "grantId",
                              "grantSelector",
                              "dispatchClass",
                              "endpoint"
                            ],
                            "properties": {
                              "sealDigest": {
                                "type": "string"
                              },
                              "grantId": {
                                "type": "string"
                              },
                              "grantSelector": {
                                "type": "string"
                              },
                              "dispatchClass": {
                                "type": "string",
                                "enum": [
                                  "read"
                                ]
                              },
                              "endpoint": {
                                "type": "string"
                              }
                            },
                            "additionalProperties": false
                          },
                          "outcome": {
                            "type": "object",
                            "required": [
                              "status",
                              "completedAt"
                            ],
                            "properties": {
                              "status": {
                                "type": "number"
                              },
                              "responseBytes": {
                                "type": "number"
                              },
                              "response": {
                                "type": "object",
                                "required": [
                                  "status",
                                  "retainedBytes",
                                  "truncated",
                                  "limitBytes"
                                ],
                                "properties": {
                                  "status": {
                                    "type": "number"
                                  },
                                  "contentType": {
                                    "type": "string"
                                  },
                                  "retainedBytes": {
                                    "type": "number"
                                  },
                                  "truncated": {
                                    "type": "boolean"
                                  },
                                  "limitBytes": {
                                    "type": "number"
                                  }
                                },
                                "additionalProperties": false
                              },
                              "provenance": {
                                "type": "object",
                                "required": [
                                  "committedBy"
                                ],
                                "properties": {
                                  "committedBy": {
                                    "type": "string",
                                    "enum": [
                                      "supervisor",
                                      "policy-auto"
                                    ]
                                  },
                                  "grantId": {
                                    "type": "string"
                                  },
                                  "grantSelector": {
                                    "type": "string"
                                  },
                                  "dispatchClass": {
                                    "type": "string",
                                    "enum": [
                                      "read"
                                    ]
                                  },
                                  "endpoint": {
                                    "type": "string"
                                  }
                                },
                                "additionalProperties": false
                              },
                              "completedAt": {
                                "type": "string",
                                "description": "a string to be decoded into a DateTime.Utc"
                              }
                            },
                            "additionalProperties": false
                          }
                        },
                        "additionalProperties": false
                      },
                      "reason": {
                        "type": "string"
                      },
                      "_tag": {
                        "type": "string",
                        "enum": [
                          "OutboxRecoveryRequired"
                        ]
                      }
                    },
                    "additionalProperties": false
                  },
                  "_tag": {
                    "type": "string",
                    "enum": [
                      "RuntimeOutboxRecoveryEvidence"
                    ]
                  }
                },
                "additionalProperties": false
              }
            ]
          }
        },
        "receipts": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "node_id",
              "sequence",
              "state",
              "error_tag",
              "output_artifacts"
            ],
            "properties": {
              "node_id": {
                "type": "string"
              },
              "sequence": {
                "type": "number"
              },
              "state": {
                "type": "string",
                "enum": [
                  "planned",
                  "running",
                  "succeeded",
                  "failed",
                  "cancelled",
                  "drifted",
                  "conflicted",
                  "uncertain",
                  "recovery-required"
                ]
              },
              "error_tag": {
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "output_artifacts": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            },
            "additionalProperties": false
          }
        }
      },
      "additionalProperties": false
    },
    "inputSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$defs": {
        "ResourceNeed": {
          "type": "object",
          "required": [
            "kind",
            "realm",
            "selector",
            "rights"
          ],
          "properties": {
            "kind": {
              "type": "string",
              "enum": [
                "path",
                "executable",
                "endpoint",
                "artifact",
                "secret",
                "stream"
              ]
            },
            "realm": {
              "type": "string"
            },
            "selector": {
              "type": "string"
            },
            "rights": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "read",
                  "write",
                  "invoke",
                  "execute",
                  "connect",
                  "emit"
                ]
              }
            }
          },
          "additionalProperties": false
        }
      },
      "type": "object",
      "required": [
        "executable",
        "args",
        "cwd"
      ],
      "properties": {
        "executable": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "descendantExecutables": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "env": {
          "type": "object",
          "required": [],
          "properties": {},
          "additionalProperties": {
            "type": "string"
          }
        },
        "cellProfile": {
          "type": "string",
          "enum": [
            "compatibility",
            "native-contained",
            "vm-enclosed"
          ]
        },
        "timeoutMs": {
          "type": "number"
        },
        "stdin": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "discard",
                "inherit"
              ]
            },
            {
              "type": "object",
              "required": [
                "kind",
                "value"
              ],
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "text"
                  ]
                },
                "value": {
                  "type": "string"
                }
              },
              "additionalProperties": false
            },
            {
              "type": "object",
              "required": [
                "kind",
                "id"
              ],
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "artifact"
                  ]
                },
                "id": {
                  "type": "string"
                }
              },
              "additionalProperties": false
            }
          ]
        },
        "stdout": {
          "type": "string",
          "enum": [
            "capture",
            "discard",
            "inherit"
          ]
        },
        "stderr": {
          "type": "string",
          "enum": [
            "capture",
            "discard",
            "inherit"
          ]
        },
        "outputLimitBytes": {
          "type": "number"
        },
        "readable": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/ResourceNeed"
          }
        },
        "writable": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/ResourceNeed"
          }
        },
        "realm": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  }
}
```

### file.read

```json
{
  "schemaVersion": "airlock/discovery/v1",
  "action": {
    "name": "file.read",
    "node": "Capture",
    "summary": "Capture file bytes, text, or JSON.",
    "resultSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$defs": {
        "AirlockLanguageValue": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "number"
            },
            {
              "type": "boolean"
            },
            {
              "type": "null"
            },
            {
              "type": "object",
              "required": [
                "kind",
                "value",
                "unit"
              ],
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "Duration"
                  ]
                },
                "value": {
                  "type": "number"
                },
                "unit": {
                  "type": "string",
                  "enum": [
                    "ms",
                    "s",
                    "m",
                    "h",
                    "d"
                  ]
                }
              },
              "additionalProperties": false
            },
            {
              "type": "array",
              "items": {
                "$ref": "#/$defs/AirlockLanguageValue"
              }
            },
            {
              "type": "object",
              "required": [],
              "properties": {},
              "additionalProperties": {
                "$ref": "#/$defs/AirlockLanguageValue"
              }
            }
          ]
        }
      },
      "anyOf": [
        {
          "type": "string",
          "description": "format=text returns decoded UTF-8 text.",
          "title": "text"
        },
        {
          "type": "array",
          "items": {
            "type": "number"
          },
          "description": "format=bytes returns byte values as a number array.",
          "title": "bytes"
        },
        {
          "$ref": "#/$defs/AirlockLanguageValue"
        }
      ],
      "description": "file.read returns text, a number array of bytes, or the recursive Airlock language-value union for format=json."
    },
    "inputSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "required": [
        "path"
      ],
      "properties": {
        "path": {
          "type": "string"
        },
        "realm": {
          "type": "string"
        },
        "format": {
          "type": "string",
          "enum": [
            "text",
            "bytes",
            "json"
          ]
        }
      },
      "additionalProperties": false
    }
  }
}
```

### file.stat

```json
{
  "schemaVersion": "airlock/discovery/v1",
  "action": {
    "name": "file.stat",
    "node": "Capture",
    "summary": "Capture filesystem metadata without following symlinks by default.",
    "resultSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "required": [
        "path",
        "kind",
        "bytes",
        "mode",
        "device",
        "inode"
      ],
      "properties": {
        "path": {
          "type": "string"
        },
        "kind": {
          "type": "string",
          "enum": [
            "file",
            "directory"
          ]
        },
        "bytes": {
          "type": "number"
        },
        "mode": {
          "type": "number"
        },
        "device": {
          "type": "number"
        },
        "inode": {
          "type": "number"
        }
      },
      "additionalProperties": false
    },
    "inputSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "required": [
        "path"
      ],
      "properties": {
        "path": {
          "type": "string"
        },
        "realm": {
          "type": "string"
        },
        "followSymlinks": {
          "type": "boolean"
        }
      },
      "additionalProperties": false
    }
  }
}
```

The evaluator returns `bytes`; there is no `size` field.

### file.glob

```json
{
  "schemaVersion": "airlock/discovery/v1",
  "action": {
    "name": "file.glob",
    "node": "Capture",
    "summary": "Capture a glob expansion rooted at an explicit path.",
    "resultSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "inputSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "required": [
        "root",
        "pattern"
      ],
      "properties": {
        "root": {
          "type": "string"
        },
        "pattern": {
          "type": "string"
        },
        "realm": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  }
}
```

### file.write

```json
{
  "schemaVersion": "airlock/discovery/v1",
  "action": {
    "name": "file.write",
    "node": "Apply",
    "summary": "Apply a held file write from content or an artifact.",
    "resultSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "required": [
        "state",
        "action",
        "act_id",
        "target",
        "previous_held",
        "bytes"
      ],
      "properties": {
        "state": {
          "type": "string",
          "enum": [
            "applied"
          ]
        },
        "action": {
          "type": "string",
          "enum": [
            "file.write"
          ]
        },
        "act_id": {
          "type": "string",
          "description": "a string matching the pattern ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
        },
        "target": {
          "type": "string"
        },
        "previous_held": {
          "type": "boolean"
        },
        "bytes": {
          "type": "number"
        }
      },
      "additionalProperties": false
    },
    "inputSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "required": [
        "path"
      ],
      "properties": {
        "path": {
          "type": "string"
        },
        "realm": {
          "type": "string"
        },
        "content": {
          "type": "string"
        },
        "sourceArtifact": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  }
}
```

### http.stage

```json
{
  "schemaVersion": "airlock/discovery/v1",
  "action": {
    "name": "http.stage",
    "node": "RequestExternal",
    "summary": "Stage an HTTP intent; it cannot dispatch from this lowering.",
    "resultSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "required": [
        "state",
        "action",
        "emission_id",
        "method",
        "endpoint",
        "hold_millis"
      ],
      "properties": {
        "state": {
          "type": "string",
          "enum": [
            "staged",
            "committing",
            "committed",
            "uncertain",
            "cancelled"
          ]
        },
        "action": {
          "type": "string",
          "enum": [
            "http.stage"
          ]
        },
        "emission_id": {
          "type": "string"
        },
        "method": {
          "type": "string",
          "enum": [
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE"
          ]
        },
        "endpoint": {
          "type": "string"
        },
        "hold_millis": {
          "type": "number"
        },
        "committed_by": {
          "type": "string",
          "enum": [
            "supervisor",
            "policy-auto"
          ]
        },
        "dispatch_class": {
          "type": "string",
          "enum": [
            "read"
          ]
        },
        "grant_id": {
          "type": "string"
        },
        "grant_selector": {
          "type": "string"
        },
        "dispatched_endpoint": {
          "type": "string"
        },
        "status": {
          "type": "number"
        },
        "response_bytes": {
          "type": "number"
        },
        "response_truncated": {
          "type": "boolean"
        },
        "response_limit_bytes": {
          "type": "number"
        },
        "response_content_type": {
          "type": "string"
        },
        "response_artifact": {
          "type": "string"
        },
        "response_body": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "inputSchema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "required": [
        "endpoint",
        "method"
      ],
      "properties": {
        "endpoint": {
          "type": "string"
        },
        "method": {
          "type": "string",
          "enum": [
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE"
          ]
        },
        "headers": {
          "type": "object",
          "required": [],
          "properties": {},
          "additionalProperties": {
            "type": "string"
          }
        },
        "body": {
          "type": "string"
        },
        "bodyArtifact": {
          "type": "string"
        },
        "holdMillis": {
          "type": "number"
        },
        "realm": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  }
}
```

## Language

The whole grammar:

- `let <name> = <expression>` — bind a value. There is no assignment, so a
  loop cannot accumulate into an outer variable.
- `if <expression> { … } else { … }` — the `else` arm is optional.
- `for <name> in <from>..<to> { … }` — finite integer range.
- `for <name> in <captured list> { … }` — iterate a captured list.
- `assert <expression>, "message"` — fail the run on a false test.
- `return <expression>` — the program result.

Values: strings, numbers, booleans, null, durations (`30s`, `5m`), lists
(`[a, b]`), and records (`{ key: value }`). Field access `a.b`, index
access `a[0]`, operators `|| && == != < <= > >= + - * / ! -`. String `+`
concatenates.

There are no functions, no `while`, no recursion, no imports, no shell
strings, and no way to define a new action. An action call is always an
identifier applied to one record literal.

Bindings supplied by the supervisor appear as free identifiers. `workspace`
is always bound to the absolute workspace path; use it for `cwd`. File
paths in `file.*` actions are relative to the workspace.

## Worked programs

Bounded control: assert, for, if, and a managed write.

```
assert enabled, "the supervisor must enable this workload"

for entry in writes {
  let written = file.write({
    path: entry.path,
    content: entry.content
  })
  assert written.state == "applied", "write failed"
}

if expected == 3 {
  return { state: "complete", iterations: expected }
} else {
  return { state: "unexpected-input", iterations: expected }
}
```

Two processes joined by a captured stdout artifact — no shell pipe.

```
let selected = process.run({
  executable: "/usr/bin/grep",
  args: ["-n", "needle", "input.txt"],
  cwd: workspace,
  stdin: "discard",
  stdout: "capture",
  stderr: "capture",
  cellProfile: "compatibility"
})
assert selected.state == "succeeded", "grep failed"

let upper = process.run({
  executable: "/usr/bin/tr",
  args: ["a-z", "A-Z"],
  cwd: workspace,
  stdin: {
    kind: "artifact",
    id: selected.stdout_artifact.id
  },
  stdout: "capture",
  stderr: "capture",
  cellProfile: "compatibility"
})
assert upper.state == "succeeded", "tr failed"

return {
  selected: selected.stdout,
  transformed: upper.stdout
}
```

External intent is staged, never sent.

```
let staged = http.stage({
  endpoint: endpoint,
  method: "POST",
  headers: {
    "content-type": "application/json"
  },
  body: "{\"operation\":\"snapshot-ready\"}",
  holdMillis: 300000
})

assert staged.state == "staged"
return staged
```

## Reading a failure and repairing

A failed run returns a receipt containing a `failure` record:

```json
{
  "state": "failed",
  "failure": {
    "action": "file.read",
    "phase": "runtime",
    "causeTag": "RuntimeNodeFailure",
    "reason": "runtime node program/<plan>/0/node/0 finished failed"
  }
}
```

Repair from the leaves, not from a guess:

1. `causeTag` names the typed error that fired. It is the single most
   specific fact available — read it first.
2. `reason` is the leaf message underneath that tag.
3. `phase` names the seam that refused: `language` (the program did not
   parse or evaluate), `contract` (the call did not match the action
   schema), `admission` (policy refused the resource), `native-filesystem`
   or `runtime` (the effect itself failed), `outbox` (staging failed).
4. `action` names the call that failed.

Change only what the tag and reason implicate, then resubmit the whole
program. A `phase` of `admission` is a refusal, not a bug to work around:
no rewrite of the program can widen what the supervisor granted.
