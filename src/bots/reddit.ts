import { sleep } from "bun";

async function redditBot() {
  let count = 0;
  console.log("reddit bot started");
  while (true) {
    try {
      count += 1;
      console.log(`reddit bot loop count : ${count}`);
    } catch (error) {
      console.log(error);
    }
    await sleep(3000);
  }
}

export default redditBot;
