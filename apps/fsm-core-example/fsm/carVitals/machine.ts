import { assign, createMachine, fromPromise, createActor, log } from 'xstate';

async function delay(ms: number, errorProbability: number = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (Math.random() < errorProbability) {
        reject({ type: 'ServiceNotAvailable' });
      } else {
        resolve();
      }
    }, ms);
  });
}

const vitalsWorkflow = createMachine(
  {
    /** @xstate-layout N4IgpgJg5mDOIC5QDcCWAXAhgG1gYwAsw8BrAOgGEjSA1DHWAYggHsA7MM1N5FkztFlyFi5KqLpDYCbrzyZ0qdgG0ADAF016xKAAOLWBiVsdIAB6IAbACYy1ywE4ArAGYAjJYAcDy2+svLABYAGhAAT0QAtzJPJwcXT3cAdn84twBfdNDBBhFSSmoSSQZmdk5ZPgF6YUKCiWrpCvlFFTdNDVN9QxaTJHMrJzJLJKckzzcxpOHPTyTQiIR7TzJA1RsnJ09rJJdVBx9M7Ia8sULi3FKOLh5Kshya0TraBpkb5uNla3btPq6jdlMFgQllUZCcbic6wSDjcEzcqic80QE0CZGc7msnkCW3sqk8hxA93wtXEzykl3KN34d2OJLOLyaCg+Lm+nQM-16oCBYzIqiSgWsbh8gUClncDk8SIQ4zBqjlqlhLhSsKCBKJJyeRQajC0bO6xkBiGsziG2JFqy2W0cUqc1lRkOs4P841GE0yWRAbBYEDgpnVhT1HMNCAAtG4pSHLGraY9SVqpIGesHAnNwohRaCMeCESi8dto1INedYHHIImDX0gYF4WQXC44qLLEEHIFwSE0whbdEHU7MXi1u70kA */
    id: 'vitalscheck',
    context: {
      tirePressure: null,
      oilPressure: null,
      coolantLevel: null,
      battery: null
    },
    initial: 'CheckVitals',
    states: {
      CheckVitals: {
        invoke: [
          {
            src: 'checkTirePressure',
            onDone: {
              actions: assign({
                tirePressure: ({ event }) => event.output
              })
            }
          },
          {
            src: 'checkOilPressure',
            onDone: {
              actions: assign({
                oilPressure: ({ event }) => event.output
              })
            }
          },
          {
            src: 'checkCoolantLevel',
            onDone: {
              actions: assign({
                coolantLevel: ({ event }) => event.output
              })
            }
          },
          {
            src: 'checkBattery',
            onDone: {
              actions: assign({
                battery: ({ event }) => event.output
              })
            }
          }
        ],
        always: {
          guard: ({ context }) => {
            return !!(
              context.tirePressure &&
              context.oilPressure &&
              context.coolantLevel &&
              context.battery
            );
          },
          target: 'VitalsChecked'
        }
      },
      VitalsChecked: {
        type: 'final',
        output: ({ context }) => context
      }
    }
  },
  {
    actors: {
      checkTirePressure: fromPromise(async () => {
        console.log('Starting checkTirePressure');
        await delay(1000);
        console.log('Completed checkTirePressure');
        return { value: 100 };
      }),
      checkOilPressure: fromPromise(async () => {
        console.log('Starting checkOilPressure');
        await delay(1500);
        console.log('Completed checkOilPressure');
        return { value: 100 };
      }),
      checkCoolantLevel: fromPromise(async () => {
        console.log('Starting checkCoolantLevel');
        await delay(500);
        console.log('Completed checkCoolantLevel');
        return { value: 100 };
      }),
      checkBattery: fromPromise(async () => {
        console.log('Starting checkBattery');
        await delay(1200);
        console.log('Completed checkBattery');
        return { value: 100 };
      })
    }
  }
);

// https://github.com/serverlessworkflow/specification/blob/main/examples/README.md#car-vitals-checks
export const workflow = createMachine(
  {
    /** @xstate-layout N4IgpgJg5mDOIC5QGMAWZkGtkEMBOAbgJYAuOANrAMQDC+AKgK54B2kA8gGacCiBYLEgG0ADAF1EoAA4B7WKSIyWkkAA9EAFgBMAGhABPRAEYAnCYB0GgOwA2AKx2AzBpFWrWkwF9PetBmz4xGSU5gDq6Cx0eACSsOwstAzMbBDxfALC4iqy8iSKykhqiHYiGuYiJjaOdkYaLiJaIjZ6hggAtAAcIuYdRm5aNiYiIh1WDh3evuhYuISkFLDmACIyUQBq8+Q005jUEEpg5kQsBDKYh34zgZuLK+ub2-6wCMenuHlKomJf2XIKSip1Ag6jZzHYbLYhkYtB0tI5anYWog2kYOuUNDYOkMbBV7CZHK5JiBLgE5sFFo8sDQlHkWIwwBtgpTdlRVLAyCRDjhOJy8AAKIzDEQASioJNmQQW5mZ1MEx3pjIozNgP0KOX+BVAQI0JjRJlqIjslS0GiMdh1SIQfTKJicRmhlSNpoa3h8IBYMggcBU4uu5N+uXygORzQMyKMmPM8P6XUcXVGJqJvrJUvCAiisXiAY1wYQWlM5i0+eqdi0dncRvLlpRdnMZsFdg61S6OpsZaTOwlN2Wq3wiq2O3gar+H01RQQmMcPRsGnLwxMVkNHmrMPMgysQycg0cO+0Vg7-i75OlO1ltIVD0H2dHuZNFisEdqupncNsujDCA6eoNpaMO6cOqup4QA */
    id: 'checkcarvitals',
    initial: 'WhenCarIsOn',
    states: {
      WhenCarIsOn: {
        on: {
          CarTurnedOnEvent: 'DoCarVitalChecks'
        }
      },
      DoCarVitalChecks: {
        description : "",
        invoke: {
          fsmType: 'childFSM',
          src: 'vitalscheck',
          onDone: {
            actions: ({ event }) => {
              console.log('Done with vitals check', event.output);
            },
            target: 'CheckContinueVitalChecks'
          }
        }
      },
      CheckContinueVitalChecks: {
        after: {
          1000: 'DoCarVitalChecks'
        }
      }
    },
    on: {
      CarTurnedOffEvent: {
        description: "",
        actions: log('Car turned off'),
        target: '.WhenCarIsOn'
      }
    }
  },
  {
    actors: {
      vitalscheck: vitalsWorkflow
    }
  }
);

export default workflow;
// console.log(JSON.stringify(workflow.toJSON()))
// const actor = createActor(workflow);


// actor.subscribe({
//   complete() {
//     console.log('workflow completed', actor.getSnapshot().output);
//   }
// });

// actor.start();

// await delay(1000);

// actor.send({
//   type: 'CarTurnedOnEvent'
// });

// await delay(6000);

// actor.send({
//   type: 'CarTurnedOffEvent'
// });
