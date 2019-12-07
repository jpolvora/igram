import { format } from "util";
import { IgApiClient, IgLoginTwoFactorRequiredError, IgCheckpointError } from "instagram-private-api";
import { get } from "lodash";
import { prompt } from "inquirer";
import { join } from "path";
import { readJSONSync, writeJSONSync, existsSync } from "fs-extra";
import slug from "slug";
const username = process.env.USERNAME;
const password = process.env.PASSWORD;
const credentialsFile = username => join(__dirname, `./${slug(username)}.credentials.json`);
const unfollowedFile = username => join(__dirname, `./${slug(username)}.unfollowed.json`);
const followingFile = (username, seq) => join(__dirname, `./${slug(username)}.${seq}.json`);

function printMessage(message, ...args) {
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(format(message, ...args));
}

function fakeSave(data: object) {
  writeJSONSync(credentialsFile(username), data);
  return data;
}

function save(fileName: string, data: object) {
  writeJSONSync(fileName, data, {
    spaces: 2
  });
}

function fakeExists() {
  // here you would check if the data exists
  //return false;
  return existsSync(credentialsFile(username));
}

function fakeLoad() {
  return readJSONSync(credentialsFile(username));
}

const ig = new IgApiClient();
ig.state.generateDevice(username);
//ig.state.proxyUrl = process.env.IG_PROXY;

async function tryLogin(error?: Error) {
  if (!error) {
    try {
      const auth = await ig.account.login(username, password);
      return auth;
    } catch (err) {
      return tryLogin(err);
    }
  }

  console.log("error: ", error);

  if (error instanceof IgLoginTwoFactorRequiredError) {
    const twoFactorIdentifier = get(error, "response.body.two_factor_info.two_factor_identifier");

    if (!twoFactorIdentifier) {
      throw new Error("Unable to login, no 2fa identifier found");
    }

    const result = await prompt([
      {
        type: "input",
        name: "code",
        message: "Enter code"
      }
    ]);

    if (!result.code) throw new Error("Invalid input");
    try {
      const twoFactorLoginResult = await ig.account.twoFactorLogin({
        username: username,
        verificationCode: result.code,
        twoFactorIdentifier
      });
      return twoFactorLoginResult;
    } catch (err) {
      return tryLogin(err);
    }
  } else if (error instanceof IgCheckpointError) {
    try {
      await ig.challenge.auto(true);

      const result = await prompt([
        {
          type: "input",
          name: "code",
          message: "Enter code"
        }
      ]);

      if (!result.code) throw new Error("invalid input");

      await ig.challenge.sendSecurityCode(result.code);

      return tryLogin();
    } catch (err) {
      return tryLogin(err);
    }
  } else {
    throw error;
  }
}
const delay = time => new Promise(res => setTimeout(res, time));

function getRandomArbitrary(min, max) {
  return Math.random() * (max - min) + min;
}

(async () => {
  try {
    // Perform usual login
    // If 2FA is enabled, IgLoginTwoFactorRequiredError will be thrown

    ig.request.end$.subscribe(async () => {
      const serialized = await ig.state.serialize();
      delete serialized.constants; // this deletes the version info, so you'll always use the version provided by the library
      fakeSave(serialized);
    });

    if (fakeExists()) {
      // import state accepts both a string as well as an object
      // the string should be a JSON object
      await ig.state.deserialize(fakeLoad());
    }

    const auth = await tryLogin();
    const following = [];
    const followingFeed = ig.feed.accountFollowing(auth.pk);
    while (followingFeed.isMoreAvailable()) await followingFeed.items();
    const items = await followingFeed.items();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      following.push({
        id: item.pk,
        username: item.username,
        full_name: item.full_name,
        followed_by: "not_sure",
        unfollow: item.checkUnfollow.bind(item)
      });
    }

    let counter = 0;
    let archive = 0;
    const maxRecords = 100;
    for (let j = 0; j < following.length; j++) {
      const user = following[j];
      const rnd = getRandomArbitrary(1, 100);
      printMessage("[%s/%s] (%s), delay: %d", j + 1, following.length, user.username, rnd);
      await delay(rnd);
      const info = await ig.friendship.show(user.id);
      user.followed_by = info.followed_by;
      user.is_bestie = info.is_bestie;
      user.sequence = j;

      if (counter === maxRecords) {
        counter = 0;
        save(followingFile(username, archive), following.slice(j - maxRecords, j));
        archive++;
      }
      counter++;
    }

    save(followingFile(username, archive), following.slice(maxRecords * archive, counter));

    const unfollowedPeople = [];
    for (let k = 0; k < following.length; k++) {
      const user = following[k];
      if (user.followed_by === true) continue;
      try {
        await delay(getRandomArbitrary(10, 100));
        await user.unfollow();
        unfollowedPeople.push(user);
        console.log("unfollowed :" + user.username);
      } catch (error) {
        console.error(error);
      }
    }
    save(unfollowedFile(username), unfollowedPeople);
    process.exit(0);
  } catch (error) {
    console.error("unhandled error: %o", error);
    process.exit(1);
  }
})();
