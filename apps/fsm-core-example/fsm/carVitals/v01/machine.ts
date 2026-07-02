import { assign, createActor, createMachine, fromPromise, log } from "xstate";

async function delay(ms: number, errorProbability: number = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (Math.random() < errorProbability) {
        reject({ type: "ServiceNotAvailable" });
      } else {
        resolve();
      }
    }, ms);
  });
}

// https://github.com/serverlessworkflow/specification/blob/main/examples/README.md#car-vitals-checks
export const workflow = createMachine(
  {
    /** @xstate-layout N4IgpgJg5mDOIC5QGMAWZkGtkEMBOAbgJYAuOANrAMQDC+AKgK54B2kA8gGacCiBYLEgG0ADAF1EoAA4B7WKSIyWkkAA9EAFgBMAGhABPRAEYAnCYB0GgOwA2AKx2AzBpFWrWkwF9PetBmz4xGSU5gDq6Cx0eACSsOwstAzMbBDxfALC4iqy8iSKykhqiHYiGuYiJjaOdkYaLiJaIjZ6hggAtAAcIuYdRm5aNiYiIh1WDh3evuhYuISkFLDmACIyUQBq8+Q005jUEEpg5kQsBDKYh34zgZuLK+ub2-6wCMenuHlKomJf2XIKSip1Ag6jZzHYbLYhkYtB0tI5anYWog2kYOuUNDYOkMbBV7CZHK5JiBLgE5sFFo8sDQlHkWIwwBtgpTdlRVLAyCRDjhOJy8AAKIzDEQASioJNmQQW5mZ1MEx3pjIozNgP0KOX+BVAQI0JjRJlqIjslS0GiMdh1SIQfTKJicRmhlSNpoa3h8IBYMggcBU4uu5N+uXygORzQMyKMmPM8P6XUcXVGJqJvrJUvCAiisXiAY1wYQWlM5i0+eqdi0dncRvLlpRdnMZsFdg61S6OpsZaTOwlN2Wq3wiq2O3gar+H01RQQmMcPRsGnLwxMVkNHmrMPMgysQycg0cO+0Vg7-i75OlO1ltIVD0H2dHuZNFisEdqupncNsujDCA6eoNpaMO6cOqup4QA */
    id: "checkcarvitals",
    initial: "WhenCarIsOn",
    states: {
      WhenCarIsOn: {
        on: {
          CarTurnedOnEvent: "DoCarVitalChecks",
        },
      },
      DoCarVitalChecks: {
        description: "",
        invoke: {
          fsmType: "sharedFsm",
          fsmVersion: "v01",
          src: "vitalsWorkflow",
          onDone: {
            actions: ({ event }) => {
              console.log("Done with vitals check", event.output);
            },
            target: "CheckContinueVitalChecks",
          },
        },
      },
      CheckContinueVitalChecks: {
        after: {
          1000: "DoCarVitalChecks",
        },
      },
    },
    on: {
      CarTurnedOffEvent: {
        description: "",
        actions: log("Car turned off"),
        target: ".WhenCarIsOn",
      },
    },
  },
  {
    actors: {
      vitalsWorkflow: "vitalsWorkflow",
    },
  },
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
