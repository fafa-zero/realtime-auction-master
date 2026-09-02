"""Run the offline Agent evaluation suite from the repository root."""

import json

from services.agent.app.evaluation import run_evaluation

if __name__ == "__main__":
    print(json.dumps(run_evaluation(), ensure_ascii=False, indent=2))
