# Call Graph Sequence Test Sample

def sub_helper():
    print("Helper function executing...")

def task_a():
    print("Task A executing...")
    sub_helper() # 호출 3 (task_a 내 첫 번째 호출)

def task_b():
    print("Task B executing...")

def main():
    print("Program started")
    task_a()     # 호출 1: main 내 첫 번째 호출 (L. 15)
    task_b()     # 호출 2: main 내 두 번째 호출 (L. 16)
    task_a()     # 호출 3: main 내 세 번째 호출 (L. 17 - 동일 함수 다중 호출 검증)

if __name__ == "__main__":
    main()
