import { randomInt } from "node:crypto";

const starts = ["Аки", "Ая", "Изу", "Каэ", "Ки", "Ко", "Ма", "Ми", "На", "Но", "Ри", "Ру", "Са", "Суи", "Та", "То", "Ха", "Хи", "Юи", "Яэ"];
const endings = ["ка", "ки", "ко", "ми", "на", "но", "ри", "ру", "са", "су", "та", "то", "ха", "хи", "ю", "я", "сэ", "нэ", "мэ", "рэ"];

/** Compose short fictional names locally; retain only a cursor, never a name history. */
export class CharacterNames {
  private cursor = randomInt(starts.length * endings.length);

  next(occupied: Iterable<string>): string {
    const used = new Set(occupied), count = starts.length * endings.length;
    for (let attempt = 0; attempt < count; attempt++) {
      const index = this.cursor % count;
      this.cursor = (this.cursor + 137) % count;
      const name = starts[Math.floor(index / endings.length)]! + endings[index % endings.length]!;
      if (!used.has(name)) return name;
    }
    // The director bounds live sessions at 128, below the 400 combinations above.
    throw new Error("Companion name capacity exceeded");
  }
}
