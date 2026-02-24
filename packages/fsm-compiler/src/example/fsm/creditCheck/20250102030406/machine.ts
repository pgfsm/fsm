
import { fromPromise, assign, setup, createMachine, initialTransition, transition } from 'xstate';


export const CreditCheckMachineMachineConfig = createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QAoC2BDAxgCwJYDswBKAYggHtCA6AgN3IGswq0s9CiE7zN0AXXJQDaABgC6osYlAAHcrFwDK0kAA9EAJgCMAZioiNOgCwBWABwmdANgDsOsxoA0IAJ6ItGqgE4rIrycsLGxEzMxstAF8I51YcAmISMAAnJPIkqhkAG34AMzTUFgw4ji58el4lfElJFTkFSpV1BA0rKiMNHzCTZzdmkT0dDxMRSxEbQx17KJii9gTVWD5+ZnQcvmTkLRFt0li5ohqkEDrFQXxGzVb2zptu100zLSMqO2MrMyMjK1MbG2mQPbxIhUTBJSCKADC2DAmAYVAAovh1kkCFAAAQASXweSSGEqJAAygBXABGqEUh1k8lOyiOTQ0YSoZhEX38LQ6Wi0Xh0PUQVk53lMJisg22Tye-0BHBBYIgkOhsKoADVkrgci5UWiIbKwEjcOhMrAyJRmNwmIU2ECZeC+FCYXCVSj1ZrtZBdQIDbBSuV+GdquJatSGnS+VcOu9bry+v5vFsvEZJl5-PHJbMraCbXbFY61Rr8OjXRB3frDYkUmkMtk+DiClLiNa5baFQ7Vc781qdXrPd6eL7hOJKccg2cLggjP0qJYvGMDFYOVyefcx+P9IN7FYvBoxsKRFZU5bpRnG1m4SfUYXFATMGk4MbqItlhbivWj-L7VQz-mL3wrzfYIOTmDUAmi5KxWgjcwjC8LkxnGKNOQ6F5hj8XczB0AIvDMfdn2BV8m3fT8oG-X8wSNCh7yWdYn32Bs30VQjiOvUihC0KQjkAkcQwQExN1XIZfjnaCnCXDQjDMSc53MbZHl3dCNGwmi8JPD9m3PWVLyY28DUNdYZByAhcFgaEIAA4daWAh4QiZBkWg8cZQnjKNtC0cSNC3OxQkGBlfgU9N1Pw+jVK-fySLgFT7VReEAEciVwABxdBaAIcLYVRAAxNJ4VUQyBHzAAlMA5CSPg71NMpGGYOtcP85SGJCzTYBShhIpi+LEuSwiMqSLKctRAqir4HsKj9AcA3Yszzi4sDWjMWxDHMW5DC0eDbgGGwjHGcdDC8dbfMPGrmyatSbVCxrCOi2KEqS-AjvzLqesWPrCrSEryLK+hzSq2iAtPIKiPqv9bqgC62uuoH7uyx78ue4qhr7KoB1YwN6k4iyEGmpk5vQrolvg7lPAcX5zE5Bwtz3aIATTfbM0OuqToaoGQaujq-oh3roYGstUnSLJcnyai-Jpgi-sYwHzta5mbs6zLIdyqB+peuHKn9NiqRR8y1FDGasYWkxcZErZxJ0Fk3N+HRuW+HQ9pfA7hYi4L6bFv6mfam60rAPhinlmHXpNGhys+qmbaFwL7f+x3SMZiXXaod3PfYb2BqVkaJDGtWaUmtGPC5KgdHWnbzfsEwbAseCzBjXwPGZQwNusIxreqkPfrD0XI-Fy6Y7jr2FeKrmK156t+a+pTaZFgG2+d6Owa7hOe8G7hhv7VPVaHdXM81hBs68XP87sbkglLpcuXL-QTHaMDzY+bZ5Ip4fbdD1KHcbU6gaugBVfAznBmX2cTl7Sv9h9SqQdG7HlHi3ceYVCLv0-pQb+3VZZPSTgveGKtkYZ1HPyGw+gtDClMMbPwYkbBOS8rnFkJsWTQUvg3b6tUx4RygX9GBX9pYIN-nPABZpgEHmDmAu2j9w7PwZtAxKH8WGsx-lDP+sMUHK0RivDiGsmhYJwXg0YhCwhOSgloJCwQbD8gTOuGhI9+HNSfhpJ2YdmFwNYQ9OWHDkjc0rHzXEAtqZ8IfmYwRFiJ5WNEbAqWEi2FSLnsnJepk16YK0NgkQuDvjqPjJokSYFsETDPsXeJHQTDGPvs3ARrdGF+NoGIuBM8kH-zeoAiqbjeF0TyV4gpZ0mH+K-mUjmitZEpwiRgrinINyTnmn4Oc2hhRmC0WfScxseIOB4tOG+MweGgLqUDRpr8WmlI9t3H2fceZVhrDUpZP0VmQKaUUkpbtNmzx9mEhGy90FAQ3n07eet0JDLcnEsZIkz7YMwtjT480wI5KbschhpyBFXRkKqdAgSw5sxCdsypXCDm0PAfkk5azaCQpRNC+BdjykyPKovW53SHnKLApjcY2NFqDHglod4bRTCfH6DtEUokgUePqcdIRljwWJSxfqGFAi4X2IRX7JFd9gV025b43lmKoWCq8cK-F89CWoPkfc1GG8MazUpbrfWvRdAbSZJhIwnJrAdDElbW+ICUWmK5T4wpsr+U4tsYg9pvdHH9z2UPG1JjPH2p-MI5pcrsUKvSpIkVyDVVyLueNSJU1yU6vmjjGlR8Xk7zEsyE1fg3LsuWVKh1YKvEQvlbHS5yrOEB24ThW1-rzGBp5cWvlpa2nSJVT6GNJLNUgW0NvPOUE95FxLncA1ooqC2AXMYGw8ZLZ5qOQWhtMqm0hoFWW+OFbPW7JcbWX1uSQXSsdcu51Fz13uvbb2TtadV49Kzr2jNBd97F0Pga8czwPDaJ8AmKukRrWLNrXCAAIh7ZI5JP75ixMiOAfA8rLAAPIyEqI1IDyJQOogALK4AgBATIYBQqVqAciv1gHgO4gMuBpEyQoMwfWPBxDVBkMgbI1ADDWGcOhRuWguNN6N5uW0JOEIBgQi4JaGfeCIoRBITEvGJMaFAhzuUgx0jYGoAQco4sajYBaNnEaq2jTZExVVsI3uxTqHyOQfU3BhD2m13d2WF6Tp4Sr2KPXvSZk4kHAOH5Boey5cjBic+FQJarIrCQT+P8fA5AizwCOFVDVSjEAAFpzaTmCF5EdiXs6TOnMXbzu59Hefk82OLLnEDiWuBBMTOjdwaACEJqZuhyYLJrURhEFGUTtixDWeGxXRyiSNiyCrS4x01enSFqCxgLBWqa4pPdOY2wFk7B6Q0PWuImA8LnNbxdi46A6IMdL3FQgMoCGBFo5d1rZN-c1vdC7TorbRiNwUlhzbX3eLYfbHwyuMvLluJaIxCt2vrS-duoMCB3Y3lMx7iYXs6v27g3iYQvgl2ZO0Hi-263eMXYelqHcwauvYT7MHTR0J6HjE96cs4YcrXJeMQSM5uQBDC9NwWHL92Fqjjj5KraITkFQFkYDhP3CskCyFsCtdzZfEXAa-RrQtgeG5E8L40SsKXZm5K+hB6i3Y5ByerZA0Beb22Ng5Hth-AjDEqJo+04jbeduBtOwG1GuUz-S1m7Qaw4u2nuWu66BcA4YgPrp4-SROi9eDOyX7gkzPA2ihPW-R0IijR5ywHbvZXnP1xD0nUOKdvactEo3zKNyblsFNp3V21cQNBRi85uK3VtvT5YSHz3s+RhEpMTwuCAgfDkuYGrifWeY81-maxOuE7c95zh9YAfTWtGGCXPRbkdrchITV1cu5OR0p2mheZpfVcs9d421Ew+bNXL11x0liB-A-MsCMly04RRWC0bYQLxcxjecwt8XQff99LsP+skf6Ufc-cp86V+M59X8Ohp1w9mgAg9BxxYlHgngat3gS8JU991c2cREV1oV08RhG9ydTsc8j449HtPhbhWVjsv90CB8MVj0a98dT905z8EBic8DodCCDUXIdFRsdoAgXIz5ZpKCK8NcaCW0vciIec+dJ8z9u1Bc7Bc4txjYfBwguQl8j5OCqBokuQJdy5jAAhBC0VK9MDaDdMCdpD4sDcxgmQBtp1hh+CLdR1DBc5s1mQXIFDlcmd3F80qCgdg1jCxC0pADIAp85Cdt+ghllCkwoCng-BJxTUNp2h9E88UDd1gUTMmNVNSJoNLNEMA85lx08FTU3IQtL94J0JUkhMNw7JZpP8Vdmdlk0jlMMiqNsjrMGj0NMNsNcNNJcjhh8jvhCiRMSij5vhPBghmR+QXI5IEw+82izM1MsiaMrNKAdMxC9N9dRJgh5CHBjAodDB-NRiBMJjZNRJkjndjMSNTMVM2tmjFi6M9MAAFVIJKIsf3MwkrTeAuJkOyWJfoZyPzNNKyMYsYEmY2LBPvbSIjN6fXYUNocMLoKML4VoawcYfLAwUZL4GhbSAAdTSAYByEyHIAAHcCRdIAMTQcD9E2h9FmRBgwgDFiFhjTU2gpJTAa4zcb4oggA */
  context: {
    SSN: "",
    FirstName: "",
    LastName: "",
    GavUnionScore: 0,
    EquiGavinScore: 0,
    GavperianScore: 0,
    ErrorMessage: "",
    MiddleScore: 0,
    InterestRateOptions: [],
  },
  invoke: {
    src: "fetchInterestRateOptions",
    // id: "rootInterpreterId",
    onDone: {
      target: "#allWorkflowStepDone",
      actions:'rootInterpreterIdSuccess',
    },
    onError: {
      target: "#allWorkflowStepDone",
      actions: 'rootInterpreterIdError',
    },
  },
  after: {
    short1000delay: {
      target: "#allWorkflowStepDone"
    },
    logng2000delay: {
      target: "#allWorkflowStepDone"
    },
  },
  
  initial: "creditCheck",
  states: {
    creditCheck: {
      initial: "Entering Information",
      states: {
        "Entering Information": {
          on: {
            Submit: {
              target: "Verifying Credentials",
              reenter: true,
            },
          },
        },

        "Verifying Credentials": {
          invoke: {
            input: ({ event }) => event,
            src: "verifyCredentials",
            onDone: {
              target: "CheckingCreditScores",
              actions: 'verifyCredentialsSuccess',
            },
            onError: [
              {
                target: "Entering Information",
                actions: assign({
                  ErrorMessage: ({
                    event,
                  }: {
                    context: any;
                    event: { error: any };
                  }) => "Failed to verify credentials. Details: " + event.error,
                }),
              },
            ],
          },
          after: {
            vc1000delay: {
              target: "#allWorkflowStepDone"
            },
            vc2000delay: {
              target: "#allWorkflowStepDone"
            },
          },
        },

        CheckingCreditScores: {
          description:
            "Kick off a series of requests to the 3 American Credit Bureaus and await their results",
          invoke:{
            src: "CheckingCreditScores3parallel"
          },
          on:{
                allstepfinished :{
                target : "#allWorkflowStepDone"
                }
            },    
          states: {
            CheckingEquiGavin: {
              entry: 'CheckingEquiGavinEntry',
              exit: 'CheckingEquiGavinExit',
              initial: "CheckingForExistingReport",
              states: {
                CheckingForExistingReport: {
                  exit: 'CheckingForExistingReportExit',
                  invoke: {
                    input: ({ context: { SSN } }) => ({
                      bureauName: "EquiGavin",
                      ssn: SSN,
                    }),
                    src: "checkReportsTable",
                    // id: "equiGavinDBActor",
                    onDone: [
                      {
                        actions: 'equiGavinDBActorSuccess',
                        target: "FetchingComplete",
                        // guard: "equiGavinReportFound",
                      },
                      {
                        target: "FetchingReport",
                      },
                    ],
                    onError: [
                      {
                        target: "FetchingFailed",
                      },
                    ],
                  },
                },
                FetchingComplete: {
                  type: "final",
                  entry: [
                    {
                      type: "saveReport",
                      params: {
                        bureauName: "EquiGavin",
                      },
                    },
                  ],
                },
                FetchingReport: {
                  id: "FetchingReportMagicIDatequiGavinFetchActor",
                  invoke: {
                    input: ({ context: { SSN } }) => ({
                      bureauName: "EquiGavin",
                      ssn: SSN,
                    }),
                    src: "checkBureau",
                    // id: "equiGavinFetchActor",
                    onDone: [
                      {
                        actions: 'equiGavinFetchActorSuccess',
                        target: "FetchingComplete",
                      },
                    ],
                    onError: [
                      {
                        target: "FetchingFailed",
                      },
                    ],
                  },
                },
                FetchingFailed: {
                  type: "final",
                },
              },
            },
            CheckingGavUnion: {
              exit: 'CheckingGavUnionExit',
              initial: "CheckingForExistingReport",
              states: {
                CheckingForExistingReport: {
                  invoke: {
                    input: ({ context: { SSN } }) => ({
                      bureauName: "GavUnion",
                      ssn: SSN,
                    }),
                    src: "checkReportsTable",
                    // id: "gavUnionDBActor",
                    onDone: [
                      {
                        actions: 'gavUnionDBActorSuccess',
                        target: "FetchingComplete",
                        // guard: "gavUnionReportFound",
                      },
                      {
                        target: "FetchingReport",
                      },
                    ],
                    onError: [
                      {
                        target: "FetchingFailed",
                      },
                    ],
                  },
                },
                FetchingComplete: {
                  type: "final",
                  entry: [
                    'FetchingCompleteEntryAction',
                  ],
                },
                FetchingReport: {
                  invoke: {
                    input: ({ context: { SSN } }) => ({
                      bureauName: "GavUnion",
                      ssn: SSN,
                    }),
                    src: "checkBureau",
                    // id: "gavUnionFetchActor",
                    onDone: [
                      {
                        actions: 'gavUnionFetchActorSuccess',
                        target: "FetchingComplete",
                      },
                    ],
                    onError: [
                      {
                        target: "FetchingFailed",
                      },
                    ],
                  },
                },
                FetchingFailed: {
                  type: "final",
                },
              },
            },
            CheckingGavperian: {
              entry: 'CheckingGavperianEntry',
              initial: "CheckingForExistingReport",
              states: {
                CheckingForExistingReport: {
                  exit: 'CheckingForExistingReportExit',
                  invoke: {
                    input: ({ context: { SSN } }) => ({
                      bureauName: "Gavperian",
                      ssn: SSN,
                    }),
                    src: "checkReportsTable",
                    // id: "gavperianCheckActor",
                    onDone: [
                      {
                        actions: 'gavperianCheckActorSuccess',
                        target: "FetchingComplete",
                        // guard: "gavperianReportFound",
                      },
                      {
                        target: "FetchingReport",
                      },
                    ],
                    onError: [
                      {
                        target: "FetchingFailed",
                      },
                    ],
                  },
                },
                FetchingComplete: {
                  type: "final",
                  entry: [
                    {
                      type: "saveReport",
                      params: {
                        bureauName: "Gavperian",
                      },
                    },
                  ],
                },
                FetchingReport: {
                  invoke: {
                    input: ({ context: { SSN } }) => ({
                      ssn: SSN,
                      bureauName: "Gavperian",
                    }),
                    src: "checkBureau",
                    // id: "checkGavPerianActor",
                    onDone: [
                      {
                        actions: 'checkGavPerianActorSuccess',
                        target: "FetchingComplete",
                      },
                    ],
                    onError: [
                      {
                        target: "FetchingFailed",
                      },
                    ],
                  },
                },
                FetchingFailed: {
                  type: "final",
                },
              },
            },
          },
          type: "parallel",
          onDone: [
            {
              target: "DeterminingInterestRateOptions",
              // guard: "allSucceeded",
              reenter: true,
            },
            {
              target: "Entering Information",
              actions: assign({
                ErrorMessage: ({ context }) =>
                  "Failed to retrieve credit scores.",
              }),
            },
          ],
        },

        DeterminingInterestRateOptions: {
          description:
            "After retrieving results, determine the middle score to be used in home loan interest rate decision",
          initial: "DeterminingMiddleScore",
          states: {
            DeterminingMiddleScore: {
              invoke: {
                input: ({
                  context: { EquiGavinScore, GavUnionScore, GavperianScore },
                }) => [EquiGavinScore, GavUnionScore, GavperianScore],
                src: "determineMiddleScore",
                // id: "scoreDeterminationActor",
                onDone: [
                  {
                    actions: [
                      assign({
                        MiddleScore: ({ event }) => event.output,
                      }),
                      {
                        type: "saveCreditProfile",
                      },
                    ],
                    target: "FetchingRates",
                  },
                ],
              },
            },
            FetchingRates: {
              invoke: {
                input: ({ context: { MiddleScore } }) => MiddleScore,
                src: "generateInterestRates",
                onDone: [
                  {
                    actions: 'generateInterestRatesSuccess',
                    target: "#allWorkflowStepDone",
                  },
                ],
              },
            },
            RatesProvided: {
              entry: [
                {
                  type: "emailUser",
                },
                {
                  type: "emailSalesTeam",
                },
              ],
              type: "final",
            },
          },
        },
        "allcreditCheckdone":{
          type: "final"
        }
      },
    },
    allWorkflowStepDone: {
      entry: ['allWorkflowStepDoneEntryAction'],
      id: "allWorkflowStepDone",
      type: "final",
    }
  },
})

export default CreditCheckMachineMachineConfig;