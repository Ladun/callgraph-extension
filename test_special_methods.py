# Special Dunder Methods & Constructor Redirect Test Sample

class Account:
    def __init__(self, owner, balance=0):
        self.owner = owner
        self.balance = balance
        print(f"Account for {self.owner} created.")

    def __repr__(self):
        # repr() 호출 시 암묵적 호출 확인용
        return f"Account('{self.owner}', {self.balance})"

    def __enter__(self):
        # with 구문 진입 시 호출 확인용
        print("Entering account context")
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        # with 구문 종료 시 호출 확인용
        print("Exiting account context")

    def __call__(self, amount):
        # 객체를 함수처럼 호출 시 (__call__) 확인용
        self.balance += amount
        print(f"Deposited {amount}, new balance: {self.balance}")

    def __del__(self):
        # 객체 소멸 시 암묵적 호출 확인용
        print(f"Account for {self.owner} destroyed.")

def main():
    print("Initializing test run...")
    
    # 1. 생성자 호출 검증 (Account() 호출이 Account.__init__ 으로 리다이렉션)
    acc = Account("Alice", 1000)
    
    # 2. 컨텍스트 매니저 호출 검증 (with acc -> __enter__, __exit__)
    with acc as a:
        # 3. 객체 직접 호출 검증 (a(500) -> __call__)
        a(500)
    
    # 4. 표현식 호출 검증 (repr(acc) -> __repr__)
    representation = repr(acc)
    print(representation)
    
    # 5. 소멸자 호출 검증 (del acc -> __del__)
    del acc

if __name__ == "__main__":
    main()
